// Abuse gate for the public registration endpoints.
//
// `POST /register` is unauthenticated by construction: the Worker URL ships
// inside the iOS binary and the only credential the app has is an APNs device
// token, which the Worker cannot verify. A security review exploited that by
// posting 250 fabricated tokens in 0.47s from a single client, each in its own
// coordinate, and every one of those coordinates became a permanent line item
// in the cron's WeatherKit fan-out.
//
// Two independent limits close that, and they are deliberately different in
// kind:
//
//   1. A per-client throttle bounds how fast anyone can register at all.
//   2. A hard ceiling on distinct grid cells bounds what registrations can
//      ever cost, no matter how many clients cooperate. The throttle can be
//      spread across a botnet; the cell cap cannot.
//
// Neither one authenticates anybody. Making fabricated tokens impossible needs
// App Attest (see the security review's item 9); this is the bound that holds
// until then.

import { Env, GridCell } from './types';

// ---------------------------------------------------------------------------
// The cell cap
// ---------------------------------------------------------------------------

// Hard ceiling on the number of distinct ~1.1 km grid cells this service will
// ever fetch weather for. It is the smaller of two independent ceilings:
//
//   1. WeatherKit quota. The cron is `*/10 * * * *` (wrangler.toml), so it
//      fires 144 times a day = 144 x 30.44 ~= 4,383 times a month, and issues
//      exactly one WeatherKit fetch per distinct cell per tick. Apple's
//      Developer Program includes 500,000 calls/month, so the quota alone
//      allows 500,000 / 4,383 ~= 114 cells - and that allotment is shared with
//      every on-device WeatherKit call the app itself makes.
//
//   2. Workers subrequest limit. One Worker invocation may make 50 external
//      subrequests on the Free plan, and the cron fans out one fetch per cell
//      inside a single invocation, so the 51st cell breaks the cron outright.
//      (The Paid plan raises this to 10,000; we do not assume Paid, and this
//      number is correct under either.)
//
// 50 is the Free-plan-safe figure. At 50 cells the cron costs
// 50 x 4,383 = 219,150 WeatherKit calls/month - 44% of the allotment - leaving
// the rest for the app's own foreground forecasts.
//
// Raising this is a deliberate act: check the Workers plan first (a value above
// 50 requires Paid) and re-run the quota arithmetic above.
export const MAX_GRID_CELLS = 50;

// ---------------------------------------------------------------------------
// The registration throttle
// ---------------------------------------------------------------------------

// The app re-registers on every foreground and on any move over 10 km
// (LocationService.swift), so a real user might register a handful of times in
// ten minutes, and a household - or a block of strangers sharing one
// carrier-NAT egress IP - several times that. 20 per 10 minutes leaves all of
// that untouched while cutting the observed attack (250 registrations in 0.47s
// from one client) off after the first 20.
export const RATE_LIMIT_WINDOW_SECONDS = 600;
export const RATE_LIMIT_MAX_REQUESTS = 20;

// How long a `device:` record survives without being refreshed. The app
// re-registers on foreground and on any significant move, so a live install
// renews its own record continuously; a fabricated one, which nothing ever
// refreshes, evaporates. Before this existed the only pruning path was a push
// failure, which never fires for a coordinate where it never rains - which is
// why planted registrations used to be permanent.
export const DEVICE_RECORD_TTL_SECONDS = 45 * 24 * 60 * 60; // 45 days

// KV's minimum accepted expirationTtl.
const MIN_KV_TTL_SECONDS = 60;

const RATE_LIMIT_PREFIX = 'ratelimit:';
const CELL_MARKER_PREFIX = 'gridcell:';
const CELL_COUNT_KEY = 'gridcells:count';

export interface RateDecision {
  ok: boolean;
  /** Seconds until the caller's window rolls over. Only meaningful when !ok. */
  retryAfterSeconds: number;
}

export interface CellDecision {
  ok: boolean;
  /** Distinct cells currently accounted for. Only meaningful when !ok. */
  cells: number;
}

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

// The address is hashed before it becomes a KV key so that a rate-limit key is
// not a short-lived log of who talked to us. This is bookkeeping hygiene, not
// anonymisation: the IPv4 space is small enough to brute-force a hash.
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
// In-isolate burst counter
// ---------------------------------------------------------------------------

// KV reads are served from a colo-local cache with a 60-second floor, so a
// burst can out-run the durable counter below: every request in a
// half-second flood may read the same stale value and conclude it is the
// first. The isolate serving that flood, on the other hand, sees every request
// synchronously.
//
// So this counter sits in *front* of the KV counter rather than replacing it.
// It is explicitly best-effort - per-isolate, lost on eviction, invisible to
// other colos - and it is not the thing that makes the system safe on its own.
// It exists because it is precisely, and only, good at the case KV is
// precisely, and only, bad at.
const burstCounts = new Map<string, number>();
let burstWindow = -1;

// Bound on distinct clients tracked in one window, so a rotating-source flood
// cannot grow this map without limit. Overflow drops the map and starts again:
// the KV counter still holds.
const MAX_TRACKED_CLIENTS = 10_000;

function countBurst(bucket: string, window: number): number {
  if (window !== burstWindow || burstCounts.size >= MAX_TRACKED_CLIENTS) {
    burstCounts.clear();
    burstWindow = window;
  }
  const next = (burstCounts.get(bucket) ?? 0) + 1;
  burstCounts.set(bucket, next);
  return next;
}

/** Test seam: drop the in-isolate burst state. */
export function resetBurstCounter(): void {
  burstCounts.clear();
  burstWindow = -1;
}

// ---------------------------------------------------------------------------
// Rate limit
// ---------------------------------------------------------------------------

export async function checkRegistrationRate(request: Request, env: Env): Promise<RateDecision> {
  const now = Date.now();
  const windowMs = RATE_LIMIT_WINDOW_SECONDS * 1000;
  const window = Math.floor(now / windowMs);
  const retryAfterSeconds = Math.max(1, Math.ceil(((window + 1) * windowMs - now) / 1000));

  const bucket = await clientBucket(request);
  const key = `${RATE_LIMIT_PREFIX}${bucket}:${window}`;

  if (countBurst(key, window) > RATE_LIMIT_MAX_REQUESTS) {
    return { ok: false, retryAfterSeconds };
  }

  try {
    const seen = parseInt((await env.DEVICES.get(key)) ?? '0', 10) || 0;
    if (seen >= RATE_LIMIT_MAX_REQUESTS) {
      return { ok: false, retryAfterSeconds };
    }
    await env.DEVICES.put(key, String(seen + 1), {
      expirationTtl: RATE_LIMIT_WINDOW_SECONDS + MIN_KV_TTL_SECONDS,
    });
  } catch (err) {
    // A KV blip must not lock every real user out of registering. Failing open
    // here cannot reopen the flood hole, because the burst counter above has
    // already run and does not touch KV.
    console.warn(`[Abuse] Rate-limit bookkeeping failed, allowing request: ${err}`);
  }

  return { ok: true, retryAfterSeconds: 0 };
}

// ---------------------------------------------------------------------------
// Cell cap
// ---------------------------------------------------------------------------

/**
 * Admits a registration into `gridKey`, enforcing MAX_GRID_CELLS.
 *
 * A cell that is already tracked is always admitted - existing users can always
 * re-register, move within their cell, or change their lead time, even once the
 * service is full. Only a registration that would open a *new* cell, and so add
 * ~4,383 WeatherKit calls a month, can be turned away.
 */
export async function reserveGridCell(gridKey: string, env: Env): Promise<CellDecision> {
  const markerKey = `${CELL_MARKER_PREFIX}${gridKey}`;

  let cells = 0;
  try {
    const [marker, counted] = await Promise.all([
      env.DEVICES.get(markerKey),
      env.DEVICES.get(CELL_COUNT_KEY),
    ]);
    cells = parseInt(counted ?? '0', 10) || 0;

    if (marker === null) {
      if (cells >= MAX_GRID_CELLS) {
        return { ok: false, cells };
      }
      // Marker and count are two writes and cannot be atomic; the cron
      // recomputes the true count from KV every tick (recordGridCellCount), so
      // any drift from concurrent registrations self-corrects within 10
      // minutes, and selectCellsWithinCap enforces the cap absolutely in the
      // meantime.
      await env.DEVICES.put(CELL_COUNT_KEY, String(cells + 1));
    }

    // The marker's lifetime tracks the registration's, so a cell whose devices
    // have all expired stops being remembered at roughly the same time.
    await env.DEVICES.put(markerKey, '1', { expirationTtl: DEVICE_RECORD_TTL_SECONDS });
  } catch (err) {
    // As above: prefer a working service over a strictly-accounted one. The
    // cron-side cap is what actually protects the quota.
    console.warn(`[Abuse] Grid-cell bookkeeping failed, allowing registration: ${err}`);
  }

  return { ok: true, cells };
}

/** Publishes the authoritative distinct-cell count for reserveGridCell to budget against. */
export async function recordGridCellCount(cells: number, env: Env): Promise<void> {
  try {
    await env.DEVICES.put(CELL_COUNT_KEY, String(cells));
  } catch (err) {
    console.warn(`[Abuse] Could not record grid-cell count: ${err}`);
  }
}

/**
 * The cap's last line of defence: whatever ends up in KV, the cron never fans
 * out to more than MAX_GRID_CELLS cells in one invocation. This is what makes
 * the Free plan's 50-subrequest ceiling unreachable even if the registration
 * side is raced, mis-counted, or bypassed entirely.
 *
 * Cells are kept oldest-registration-first, so a flood of new coordinates
 * cannot displace the users who were already here.
 */
export function selectCellsWithinCap(grids: GridCell[]): { cells: GridCell[]; skipped: number } {
  if (grids.length <= MAX_GRID_CELLS) return { cells: grids, skipped: 0 };

  const oldest = (cell: GridCell): string =>
    cell.devices.reduce(
      (earliest, device) => (device.registeredAt < earliest ? device.registeredAt : earliest),
      '9999'
    );

  const ranked = [...grids].sort((a, b) => {
    const byAge = oldest(a).localeCompare(oldest(b));
    return byAge !== 0 ? byAge : a.gridKey.localeCompare(b.gridKey);
  });

  return { cells: ranked.slice(0, MAX_GRID_CELLS), skipped: grids.length - MAX_GRID_CELLS };
}
