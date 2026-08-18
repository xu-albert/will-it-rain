// Abuse gate for the public registration endpoints.
//
// `POST /register` is unauthenticated by construction: the Worker URL ships
// inside the iOS binary and the only credential the app has is an APNs device
// token, which the Worker cannot verify. A security review exploited that by
// posting 250 fabricated tokens in 0.47s from a single client, each in its own
// coordinate, and every one of those coordinates became a permanent line item
// in the cron's WeatherKit fan-out.
//
// Three limits close that, and they are deliberately different in kind:
//
//   1. A per-client throttle bounds how fast anyone can register at all.
//   2. Hard ceilings on distinct grid cells, and on devices inside one cell,
//      bound what registrations can ever cost, no matter how many clients
//      cooperate. The throttle can be spread across a botnet; the caps cannot.
//   3. A per-invocation push budget bounds what one cron tick can spend, so the
//      headroom the caps leave is real rather than notional.
//
// The first two are counted in Durable Objects (durable.ts) rather than KV,
// because KV cannot count a burst: its reads come from a colo-local cache with
// a 60-second floor, so every request in a sub-second flood reads the same
// pre-flood value.
//
// None of this authenticates anybody. Making fabricated tokens impossible needs
// App Attest (see the security review's item 9); this is the bound that holds
// until then.

import { CoverageMap, CoverageReply, DeviceRegistration, Env, GridCell, RateReply } from './types';

// ---------------------------------------------------------------------------
// The fan-out budget
// ---------------------------------------------------------------------------

// This Worker runs on the Cloudflare Workers FREE plan, which allows **50
// external subrequests per invocation** — one shared pool for everything the
// cron does over the network. Durable Object calls and KV operations are
// INTERNAL subrequests and come out of a separate 1,000-per-invocation bucket,
// so they must not be counted against the 50.
//
// One cron tick spends, out of that 50:
//
//   * 1 WeatherKit fetch per distinct grid cell            (weatherkit.ts)
//   * up to 2 pushes per notified device — the rain alert,
//     plus a Live Activity update when the device has an
//     activityToken                                        (apns.ts)
//
// so the ceiling on cells and the ceiling on pushes have to be chosen together:
//
//   MAX_GRID_CELLS             = 15 -> 15 external fetches, leaving 35 of the 50
//   PUSH_BUDGET_PER_INVOCATION = 34 -> 17 notified devices at 2 pushes each, +1
//                                      spare
//   MAX_DEVICES_PER_CELL       = 20 -> at most 15 x 20 = 300 device records, so
//                                      300 internal KV gets in readCoverage,
//                                      comfortably under the 1,000 internal
//                                      ceiling
//
// Enforcing the push budget is not optional bookkeeping. Overrunning the 50
// makes the next fetch throw "Too many subrequests"; notifyOnce catches that
// and hands it to recordPushFailure, which returns early for anything that is
// not an APNsError — so the overrun would be swallowed, the tick would report
// success, and alerts would stop for an arbitrary, scheduling-order-dependent
// subset of users. createPushBudget below refuses deterministically instead,
// oldest cell first, and says so with console.error.
//
// WeatherKit quota cross-check — informative, not the binding constraint: the
// cron is `*/10 * * * *` (wrangler.toml), so it fires 144 times a day = 144 x
// 30.44 ~= 4,383 times a month, and 15 cells x 4,383 = 65,745 calls/month, 13%
// of the 500,000 Apple's Developer Program includes. The rest is left for the
// app's own on-device forecasts.
//
// The cap is set by the Free-plan subrequest budget, NOT by the WeatherKit
// quota. Raising it means moving to the Workers Paid plan — which raises the
// external subrequest limit to 1,000 per invocation — and re-running every line
// of arithmetic above.
export const MAX_GRID_CELLS = 15;
export const PUSH_BUDGET_PER_INVOCATION = 34;
export const MAX_DEVICES_PER_CELL = 20;

/** The most `device:` records one cron tick will read, = MAX_GRID_CELLS x MAX_DEVICES_PER_CELL. */
export const MAX_DEVICE_RECORDS = MAX_GRID_CELLS * MAX_DEVICES_PER_CELL;

// ---------------------------------------------------------------------------
// The registration throttle
// ---------------------------------------------------------------------------

// The app registers on cold launch, on every foreground, at the end of every
// successful weather poll, and on any move over 10 km, so a real user might
// register a handful of times in ten minutes, and a household — or a block of
// strangers sharing one carrier-NAT egress IP — several times that. 20 per 10
// minutes leaves all of that untouched while cutting the observed attack (250
// registrations in 0.47s from one client) off after the first 20.
export const RATE_LIMIT_WINDOW_SECONDS = 600;
export const RATE_LIMIT_MAX_REQUESTS = 20;

// How long a `device:` record survives without being refreshed. Renewal is not
// incidental: ContentView re-registers on cold launch, unconditionally on
// willEnterForeground, and after every successful weather poll, and
// LocationService re-registers on any move over 10 km — so a live install
// rewrites its own record long before 45 days pass, while a fabricated one,
// which nothing ever refreshes, evaporates. Before this existed the only
// pruning path was a push failure, which never fires for a coordinate where it
// never rains — which is why planted registrations used to be permanent.
export const DEVICE_RECORD_TTL_SECONDS = 45 * 24 * 60 * 60; // 45 days

// Records written before the TTL existed carry no expiration and KV cannot add
// one after the fact, so the cron rewrites them as it meets them. Bounded per
// tick because the Free plan allows 1,000 KV writes a day and this shares that
// budget: 5 x 144 ticks = 720/day even in the pathological case where the
// supply never runs out. It does run out — every writer goes through
// putDeviceRecord, so a migrated record is never seen again.
export const MAX_TTL_MIGRATIONS_PER_TICK = 5;

// ---------------------------------------------------------------------------
// Client identity
// ---------------------------------------------------------------------------

// `CF-Connecting-IP` is written by Cloudflare's edge on every request and
// overwrites whatever the client sent, so it cannot be forged from outside.
// When it is absent - `wrangler dev`, or a unit test - everything shares one
// bucket, which throttles harder rather than softer.
function clientAddress(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

// The address is hashed before it names a Durable Object so that the instance
// name is not a short-lived log of who talked to us. This is bookkeeping
// hygiene, not anonymisation: the IPv4 space is small enough to brute-force a
// hash.
async function clientBucket(request: Request): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(clientAddress(request))
  );
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Rate limit
// ---------------------------------------------------------------------------

export async function checkRegistrationRate(request: Request, env: Env): Promise<RateDecision> {
  const bucket = await clientBucket(request);

  try {
    const stub = env.REGISTRATION_LIMITER.get(env.REGISTRATION_LIMITER.idFromName(bucket));
    const response = await stub.fetch('https://limiter/check', {
      method: 'POST',
      body: JSON.stringify({
        windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
        maxRequests: RATE_LIMIT_MAX_REQUESTS,
      }),
    });
    return (await response.json()) as RateReply;
  } catch (err) {
    // An infrastructure blip must not lock every real user out of registering.
    // Failing open here cannot uncap the expensive thing: the coverage registry
    // is a separate object, and selectCellsWithinCap bounds the cron's fan-out
    // no matter what the registration side let through.
    console.warn(`[Abuse] Rate-limit bookkeeping failed, allowing request: ${err}`);
    return { ok: true, retryAfterSeconds: 0 };
  }
}

export type RateDecision = RateReply;
export type CellDecision = CoverageReply;

// ---------------------------------------------------------------------------
// Coverage caps
// ---------------------------------------------------------------------------

/**
 * Admits a device into `gridKey`, enforcing MAX_GRID_CELLS and
 * MAX_DEVICES_PER_CELL against the strongly consistent tally in
 * CoverageRegistry.
 *
 * A device already registered in that cell is always admitted — existing users
 * can re-register, move within their cell, or change their lead time even once
 * the service is full. Only a device that is new to a full cell, or that would
 * open a cell beyond the global cap (and so add ~4,383 WeatherKit calls a
 * month, forever), is turned away.
 */
export async function reserveGridCell(
  gridKey: string,
  deviceToken: string,
  env: Env,
  options: { incumbent?: boolean } = {}
): Promise<CellDecision> {
  try {
    const response = await coverageStub(env).fetch('https://coverage/reserve', {
      method: 'POST',
      body: JSON.stringify({
        gridKey,
        deviceToken,
        incumbent: options.incumbent === true,
        maxCells: MAX_GRID_CELLS,
        maxDevicesPerCell: MAX_DEVICES_PER_CELL,
      }),
    });
    return (await response.json()) as CoverageReply;
  } catch (err) {
    // As with the throttle: prefer a working service over a strictly-accounted
    // one. selectCellsWithinCap is what actually protects the quota.
    console.warn(`[Abuse] Grid-cell bookkeeping failed, allowing registration: ${err}`);
    return { ok: true, cells: 0, devices: 0 };
  }
}

/** Frees the cell slot a device holds. Every path that drops a `device:` record calls this. */
export async function releaseGridCell(deviceToken: string, env: Env): Promise<void> {
  try {
    await coverageStub(env).fetch('https://coverage/release', {
      method: 'POST',
      body: JSON.stringify({ deviceToken }),
    });
  } catch (err) {
    console.warn(`[Abuse] Could not release grid-cell slot: ${err}`);
  }
}

/**
 * Truth-up: hands the registry what KV actually holds, once per cron tick.
 *
 * Device records expire on their own TTL and nothing tells the registry, so
 * without this the tally would only ever grow and would eventually refuse real
 * users on behalf of cells that no longer exist.
 */
export async function reconcileCoverage(grids: GridCell[], env: Env): Promise<void> {
  const coverage: CoverageMap = {};
  for (const grid of grids) {
    coverage[grid.gridKey] = grid.devices.map((device) => device.token);
  }

  try {
    await coverageStub(env).fetch('https://coverage/reconcile', {
      method: 'POST',
      body: JSON.stringify({ coverage }),
    });
  } catch (err) {
    console.warn(`[Abuse] Could not reconcile grid-cell coverage: ${err}`);
  }
}

function coverageStub(env: Env): DurableObjectStub {
  return env.COVERAGE.get(env.COVERAGE.idFromName('global'));
}

// ---------------------------------------------------------------------------
// Push budget
// ---------------------------------------------------------------------------

export interface PushBudget {
  /** Claims one external push. False means the budget is gone and nothing was sent. */
  spend(): boolean;
  /** Pushes claimed so far. */
  readonly spent: number;
  /** Pushes refused because the budget was exhausted. */
  readonly denied: number;
}

export function createPushBudget(limit = PUSH_BUDGET_PER_INVOCATION): PushBudget {
  let spent = 0;
  let denied = 0;
  return {
    spend(): boolean {
      if (spent >= limit) {
        denied += 1;
        return false;
      }
      spent += 1;
      return true;
    },
    get spent() {
      return spent;
    },
    get denied() {
      return denied;
    },
  };
}

// ---------------------------------------------------------------------------
// Cron-side cap
// ---------------------------------------------------------------------------

/** Ascending by `registeredAt`, ties broken on token so the order is total. */
function byFirstSeen(a: DeviceRegistration, b: DeviceRegistration): number {
  if (a.registeredAt !== b.registeredAt) return a.registeredAt < b.registeredAt ? -1 : 1;
  if (a.token === b.token) return 0;
  return a.token < b.token ? -1 : 1;
}

/**
 * Puts the cron's whole work list into first-seen order, oldest first, and
 * truncates it to MAX_GRID_CELLS.
 *
 * The truncation is the caps' last line of defence: whatever ends up in KV, the
 * cron never fans out to more than MAX_GRID_CELLS cells in one invocation, which
 * keeps the Free plan's external-subrequest ceiling out of reach even if the
 * registration side is raced, mis-counted, or bypassed entirely.
 *
 * The ordering matters just as much, and it is applied unconditionally — not
 * only when the list is long enough to truncate. PUSH_BUDGET_PER_INVOCATION can
 * bind well below the cell cap (ten cells of four devices already want more
 * pushes than a tick can afford), and whoever the loop reaches last is who goes
 * unnotified. Left in KV list order that would be `device:<token-hex>` order:
 * arbitrary with respect to who was here first, and *stable*, so the same
 * devices would lose their pushes on every tick forever. Sorting devices inside
 * each cell as well as the cells themselves makes budget exhaustion fall on the
 * newest arrivals instead, which is the same incumbent-protection promise the
 * cell truncation makes.
 *
 * Both orderings are only truthful because handleRegister preserves a device's
 * original `registeredAt` across re-registrations — restamping it would invert
 * the ranking, handing every slot to whoever registered least recently.
 */
export function selectCellsWithinCap(grids: GridCell[]): { cells: GridCell[]; skipped: number } {
  // Decorate-sort-undecorate: sorting each cell's devices first makes its oldest
  // registration simply the head of that list, so no cell is scanned twice.
  const ranked = grids
    .map((cell) => {
      const devices = [...cell.devices].sort(byFirstSeen);
      return {
        cell: { gridKey: cell.gridKey, devices },
        oldest: devices[0]?.registeredAt ?? '9999',
      };
    })
    .sort((a, b) => {
      if (a.oldest !== b.oldest) return a.oldest < b.oldest ? -1 : 1;
      if (a.cell.gridKey === b.cell.gridKey) return 0;
      return a.cell.gridKey < b.cell.gridKey ? -1 : 1;
    })
    .map((entry) => entry.cell);

  return {
    cells: ranked.slice(0, MAX_GRID_CELLS),
    skipped: Math.max(0, grids.length - MAX_GRID_CELLS),
  };
}
