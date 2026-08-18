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
const WINDOW_KEY = 'window';

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
   * Admits `deviceToken` into `gridKey`, enforcing both caps.
   *
   * A device that is already in the cell it is asking for is admitted without
   * touching anything, so an existing user can always re-register, move within
   * their cell, or change their lead time even when the service is full. Only a
   * device that is genuinely new to a full cell, or that would open a cell
   * beyond the global cap, is refused.
   *
   * A device moving between cells releases its old slot first, including when
   * the move is then refused: the caller drops that device's record on a
   * capacity refusal, so leaving it counted would leak a slot forever.
   */
  private async reserve(request: Request): Promise<Response> {
    const { gridKey, deviceToken, maxCells, maxDevicesPerCell } = (await request.json()) as {
      gridKey: string;
      deviceToken: string;
      maxCells: number;
      maxDevicesPerCell: number;
    };

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
        if (occupants.length >= maxDevicesPerCell) {
          if (changed) await this.ctx.storage.put(COVERAGE_KEY, cells);
          return reply(this.refusal('cell_at_capacity', cells, gridKey));
        }
        occupants.push(deviceToken);
        changed = true;
      }
    } else {
      if (Object.keys(cells).length >= maxCells) {
        if (changed) await this.ctx.storage.put(COVERAGE_KEY, cells);
        return reply(this.refusal('coverage_at_capacity', cells, gridKey));
      }
      cells[gridKey] = [deviceToken];
      changed = true;
    }

    if (changed) await this.ctx.storage.put(COVERAGE_KEY, cells);

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

    return reply({ ok: true, cells: Object.keys(cells).length, devices: 0 } satisfies CoverageReply);
  }

  /**
   * Replaces the tally with what KV actually holds, once per cron tick.
   *
   * Device records expire on their own TTL, and nothing tells this object when
   * that happens, so without a periodic truth-up the tally would only ever grow.
   * A registration that lands between the cron's KV read and this write is
   * dropped from the tally and re-added the next time that device registers,
   * which under-counts for at most one tick. The caller skips the call entirely
   * if its KV read was truncated, so a partial read can never wipe live state.
   */
  private async reconcile(request: Request): Promise<Response> {
    const { coverage } = (await request.json()) as { coverage: CoverageMap };
    await this.ctx.storage.put(COVERAGE_KEY, coverage);
    return reply({ ok: true, cells: Object.keys(coverage).length, devices: 0 } satisfies CoverageReply);
  }
}
