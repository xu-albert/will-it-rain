// Strongly consistent accounting for the registration gate.
//
// Workers KV serves reads from a colo-local cache with a 60-second floor, so a
// counter kept in KV cannot see a sub-second flood: every request in the burst
// reads the same pre-burst value and each concludes it is the first. A Durable
// Object instance is single-threaded and its storage is strongly consistent, and
// while a storage operation is in flight the runtime delivers no other event to
// that instance — so the read-modify-write in each handler below is atomic
// against every other request in flight, wherever in the world it landed.
//
// Both classes use the SQLite storage backend (the `new_sqlite_classes`
// migration in wrangler.toml). That is not a preference: the key-value backend
// (`new_classes`) is Paid-plan only, and this account is on the Free plan.
//
// Calls into a Durable Object are INTERNAL subrequests, out of the
// 1,000-per-invocation bucket — they do not compete with WeatherKit fetches and
// APNs pushes for the 50 external subrequests the cron has to live inside (see
// the arithmetic in abuse.ts).

import { CoverageMap, CoverageReply, RateReply } from './types';

const COVERAGE_KEY = 'cells';
const RECENT_KEY = 'recent';
const WINDOW_KEY = 'window';

// How long an admission is protected from being reconciled away. Workers KV
// `list` is eventually consistent, so a device admitted moments before a cron
// tick can be missing from the snapshot that tick reads — see reconcile().
const RECONCILE_GRACE_MS = 120_000;

/** Tokens admitted recently, with the cell they were admitted into. */
type RecentAdmissions = Record<string, { gridKey: string; at: number }>;

function reply(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
}

interface RateWindow {
  window: number;
  count: number;
}

/**
 * One instance per client bucket: the fixed-window registration throttle.
 *
 * The instance deletes its own storage once the window it was tracking is well
 * past, so a rotating-source flood leaves no residue behind — a Durable Object
 * with no stored data stops existing.
 */
export class RegistrationLimiter {
  constructor(private readonly ctx: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const { windowSeconds, maxRequests } = (await request.json()) as {
      windowSeconds: number;
      maxRequests: number;
    };

    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const window = Math.floor(now / windowMs);
    const retryAfterSeconds = Math.max(1, Math.ceil(((window + 1) * windowMs - now) / 1000));

    const stored = await this.ctx.storage.get<RateWindow>(WINDOW_KEY);
    const count = stored && stored.window === window ? stored.count : 0;

    if (count >= maxRequests) {
      const refusal: RateReply = { ok: false, retryAfterSeconds };
      return reply(refusal);
    }

    await this.ctx.storage.put<RateWindow>(WINDOW_KEY, { window, count: count + 1 });
    if (count === 0) {
      // Self-cleanup one window after this one closes, so idle buckets do not
      // accumulate. Set only when the window opens, to keep this to one extra
      // write per client per window.
      await this.ctx.storage.setAlarm(now + windowMs * 2);
    }

    const decision: RateReply = { ok: true, retryAfterSeconds: 0 };
    return reply(decision);
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

/**
 * A single global instance: the authoritative set of covered grid cells and the
 * devices in each one.
 *
 * This is what makes the caps real rather than advisory. It replaced a
 * `gridcell:` marker plus a `gridcells:count` key in KV, which were two
 * non-atomic writes behind an eventually consistent read and so could drift
 * apart — and did, permanently, whenever a device left a cell without the count
 * being decremented.
 */
export class CoverageRegistry {
  constructor(private readonly ctx: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname;
    if (action === '/reserve') return this.reserve(request);
    if (action === '/release') return this.release(request);
    if (action === '/reconcile') return this.reconcile(request);
    return new Response('Not found', { status: 404 });
  }

  private async load(): Promise<CoverageMap> {
    return (await this.ctx.storage.get<CoverageMap>(COVERAGE_KEY)) ?? {};
  }

  /**
   * Drops a token's recent-admission note.
   *
   * `recent` exists to say "this device was admitted so lately that a cron
   * snapshot may not have caught up yet", so it has to stop saying that the
   * moment the device stops occupying the cell. Otherwise reconcile's grace
   * loop re-adds a device the registry has already released, resurrecting an
   * empty cell and holding a slot that a real user is then refused — and
   * refused destructively, because the caller deletes their record.
   */
  private async forgetRecent(deviceToken: string, now: number): Promise<void> {
    const recent = await this.loadRecent(now);
    if (!(deviceToken in recent)) return;
    delete recent[deviceToken];
    await this.ctx.storage.put(RECENT_KEY, recent);
  }

  /** Recent admissions, with anything past the grace window dropped. */
  private async loadRecent(now: number): Promise<RecentAdmissions> {
    const stored = (await this.ctx.storage.get<RecentAdmissions>(RECENT_KEY)) ?? {};
    const live: RecentAdmissions = {};
    for (const [token, entry] of Object.entries(stored)) {
      if (now - entry.at < RECONCILE_GRACE_MS) live[token] = entry;
    }
    return live;
  }

  /**
   * Admits `deviceToken` into `gridKey`, enforcing both caps.
   *
   * A device that is already in the cell it is asking for is admitted without
   * touching anything, so an existing user can always re-register, move within
   * their cell, or change their lead time even when the service is full. Only a
   * device that is genuinely new to a full cell, or that would open a cell
   * beyond the global cap, is refused.
   *
   * `incumbent` says the caller has verified a stored `device:` record for this
   * token at this exact gridKey, so the device already occupies real storage and
   * the cron already fetches its cell. Admitting it past a cap therefore adds
   * nothing that refusing would take away — it only repairs a tally that has
   * fallen behind the truth — while refusing would delete a live user's
   * registration. It cannot be used to grow past the caps, because incumbency
   * requires a record that only a prior successful admission could have written.
   *
   * A device moving between cells releases its old slot first, including when
   * the move is then refused: the caller drops that device's record on a
   * capacity refusal, so leaving it counted would leak a slot forever.
   */
  private async reserve(request: Request): Promise<Response> {
    const { gridKey, deviceToken, incumbent, maxCells, maxDevicesPerCell } =
      (await request.json()) as {
        gridKey: string;
        deviceToken: string;
        incumbent?: boolean;
        maxCells: number;
        maxDevicesPerCell: number;
      };

    const now = Date.now();
    const cells = await this.load();
    let changed = false;

    for (const [key, tokens] of Object.entries(cells)) {
      if (key === gridKey) continue;
      const at = tokens.indexOf(deviceToken);
      if (at === -1) continue;
      tokens.splice(at, 1);
      if (tokens.length === 0) delete cells[key];
      changed = true;
    }

    const occupants = cells[gridKey];
    if (occupants) {
      if (!occupants.includes(deviceToken)) {
        if (occupants.length >= maxDevicesPerCell && !incumbent) {
          if (changed) await this.ctx.storage.put(COVERAGE_KEY, cells);
          await this.forgetRecent(deviceToken, now);
          return reply(this.refusal('cell_at_capacity', cells, gridKey));
        }
        occupants.push(deviceToken);
        changed = true;
      }
    } else {
      if (Object.keys(cells).length >= maxCells && !incumbent) {
        if (changed) await this.ctx.storage.put(COVERAGE_KEY, cells);
        await this.forgetRecent(deviceToken, now);
        return reply(this.refusal('coverage_at_capacity', cells, gridKey));
      }
      cells[gridKey] = [deviceToken];
      changed = true;
    }

    if (changed) await this.ctx.storage.put(COVERAGE_KEY, cells);

    const recent = await this.loadRecent(now);
    recent[deviceToken] = { gridKey, at: now };
    await this.ctx.storage.put(RECENT_KEY, recent);

    const admitted: CoverageReply = {
      ok: true,
      cells: Object.keys(cells).length,
      devices: cells[gridKey]?.length ?? 0,
    };
    return reply(admitted);
  }

  private refusal(
    code: 'coverage_at_capacity' | 'cell_at_capacity',
    cells: CoverageMap,
    gridKey: string
  ): CoverageReply {
    return {
      ok: false,
      code,
      cells: Object.keys(cells).length,
      devices: cells[gridKey]?.length ?? 0,
    };
  }

  /** Frees whatever cell slot a device holds. Called whenever its record is dropped. */
  private async release(request: Request): Promise<Response> {
    const { deviceToken } = (await request.json()) as { deviceToken: string };
    const now = Date.now();
    const cells = await this.load();

    let changed = false;
    for (const [key, tokens] of Object.entries(cells)) {
      const at = tokens.indexOf(deviceToken);
      if (at === -1) continue;
      tokens.splice(at, 1);
      if (tokens.length === 0) delete cells[key];
      changed = true;
    }
    if (changed) await this.ctx.storage.put(COVERAGE_KEY, cells);
    await this.forgetRecent(deviceToken, now);

    return reply({ ok: true, cells: Object.keys(cells).length, devices: 0 } satisfies CoverageReply);
  }

  /**
   * Rebuilds the tally from what KV actually holds, once per cron tick.
   *
   * Device records expire on their own TTL, and nothing tells this object when
   * that happens, so without a periodic truth-up the tally would only ever grow.
   *
   * The snapshot is not taken as gospel, though. Workers KV `list` is eventually
   * consistent, so a device that registered shortly before the tick can simply
   * be missing from it — and dropping such a device is not the harmless
   * one-tick under-count it looks like. At capacity it is permanent: its cell
   * goes back on the market, a newcomer takes the last slot, and when the device
   * re-registers (which the client now does on every foreground) the caller
   * would refuse it and delete its record. So an admission inside
   * RECONCILE_GRACE_MS survives a snapshot that does not mention it, and only
   * entries older than that window can be reconciled away.
   *
   * The caller also skips this entirely when its KV read was truncated, so a
   * partial read can never wipe live state.
   */
  private async reconcile(request: Request): Promise<Response> {
    const { coverage } = (await request.json()) as { coverage: CoverageMap };
    const now = Date.now();

    const next: CoverageMap = {};
    for (const [gridKey, tokens] of Object.entries(coverage)) next[gridKey] = [...tokens];

    const recent = await this.loadRecent(now);
    for (const [token, entry] of Object.entries(recent)) {
      const occupants = next[entry.gridKey];
      if (!occupants) {
        next[entry.gridKey] = [token];
      } else if (!occupants.includes(token)) {
        occupants.push(token);
      }
    }

    await this.ctx.storage.put(COVERAGE_KEY, next);
    await this.ctx.storage.put(RECENT_KEY, recent);

    return reply({ ok: true, cells: Object.keys(next).length, devices: 0 } satisfies CoverageReply);
  }
}
