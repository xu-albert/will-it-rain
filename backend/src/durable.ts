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
import { normalizeGridKey } from './grid';
import { logInfo, logWarn } from './logger';

const COVERAGE_KEY = 'cells';
const RECENT_KEY = 'recent';
const PENDING_KEY = 'pendingReap';
const ACTIVITY_KEY = 'deviceActivity';
const BUCKETS_KEY = 'buckets';

// Hard ceiling on tracked IP buckets per shard within one rate-limit window.
// Each serialized entry is ~60 bytes, so 1,000 entries stays under half of the
// 128 KiB single-value DO storage ceiling while keeping the shard strictly O(1).
const MAX_BUCKETS_PER_SHARD = 1_000;

// How long an admission is protected from being reconciled away. Workers KV
// `list` is eventually consistent, so a device admitted moments before a cron
// tick can be missing from the snapshot that tick reads — see reconcile().
const RECONCILE_GRACE_MS = 120_000;

/** Tokens admitted recently, with the cell they were admitted into. */
type RecentAdmissions = Record<string, { gridKey: string; at: number }>;

/** Tokens APNs has rejected that are queued for deletion, with when they were flagged. */
type PendingReaps = Record<string, number>;

/** Last seen / renewed epoch ms per device token, for dormant-cell eviction. */
type DeviceActivity = Record<string, number>;

function reply(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
}

interface RateEntry {
  window: number;
  count: number;
  expiresAt: number;
}

type BucketMap = Record<string, RateEntry>;

/**
 * Fixed-shard registration throttle (see RATE_LIMIT_SHARDS in abuse.ts).
 *
 * Each shard holds a TTL-pruned map of hashed client buckets inside a single
 * SQLite-backed Durable Object, capping total DO instances and SQLite storage
 * at O(1) regardless of IP churn or rotating-source floods (SQLite DOs retain
 * a minimum ~4 KB page footprint even after deleteAll(), so spawning one DO per
 * unique IP caused unbounded storage growth).
 */
export class RegistrationLimiter {
  constructor(private readonly ctx: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const {
      bucket = 'default',
      windowSeconds,
      maxRequests,
    } = (await request.json()) as {
      bucket?: string;
      windowSeconds: number;
      maxRequests: number;
    };

    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const window = Math.floor(now / windowMs);
    const expiresAt = (window + 1) * windowMs;
    const retryAfterSeconds = Math.max(1, Math.ceil((expiresAt - now) / 1000));

    const stored = (await this.ctx.storage.get<BucketMap>(BUCKETS_KEY)) ?? {};
    const live: BucketMap = {};
    for (const [key, entry] of Object.entries(stored)) {
      if (entry.expiresAt > now) live[key] = entry;
    }

    const existing = live[bucket];
    const count = existing && existing.window === window ? existing.count : 0;

    if (count >= maxRequests) {
      const refusal: RateReply = { ok: false, retryAfterSeconds };
      return reply(refusal);
    }

    if (!(bucket in live)) {
      const keys = Object.keys(live);
      if (keys.length >= MAX_BUCKETS_PER_SHARD) {
        // Evict the lowest-count (then earliest-expiring) bucket so repeat
        // offenders remain throttled while single-value storage stays bounded.
        let victim = keys[0];
        for (const key of keys) {
          const a = live[key];
          const b = live[victim];
          if (a.count < b.count || (a.count === b.count && a.expiresAt < b.expiresAt)) {
            victim = key;
          }
        }
        delete live[victim];
        logWarn('do.eviction', {
          object: 'RegistrationLimiter',
          reason: 'max_buckets_per_shard',
          count: 1,
          bucketCount: keys.length,
          maxBuckets: MAX_BUCKETS_PER_SHARD,
        });
      }
    }

    live[bucket] = { window, count: count + 1, expiresAt };
    await this.ctx.storage.put<BucketMap>(BUCKETS_KEY, live);

    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm <= now) {
      await this.ctx.storage.setAlarm(now + windowMs * 2);
    }

    const decision: RateReply = { ok: true, retryAfterSeconds: 0 };
    return reply(decision);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const stored = (await this.ctx.storage.get<BucketMap>(BUCKETS_KEY)) ?? {};
    const live: BucketMap = {};
    let latestExpiry = 0;
    let prunedCount = 0;
    for (const [key, entry] of Object.entries(stored)) {
      if (entry.expiresAt > now) {
        live[key] = entry;
        if (entry.expiresAt > latestExpiry) latestExpiry = entry.expiresAt;
      } else {
        prunedCount += 1;
      }
    }
    const remainingCount = Object.keys(live).length;
    if (remainingCount === 0) {
      await this.ctx.storage.deleteAll();
    } else {
      await this.ctx.storage.put<BucketMap>(BUCKETS_KEY, live);
      await this.ctx.storage.setAlarm(latestExpiry + 1000);
    }
    logInfo('do.alarm', {
      object: 'RegistrationLimiter',
      prunedCount,
      remainingCount,
      deletedAll: remainingCount === 0,
    });
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
    if (action === '/flag-reap') return this.flagReap(request);
    if (action === '/pending-reaps') return this.pendingReaps();
    return new Response('Not found', { status: 404 });
  }

  private async load(): Promise<{ cells: CoverageMap; migrated: boolean }> {
    const stored = (await this.ctx.storage.get<CoverageMap>(COVERAGE_KEY)) ?? {};
    const cells: CoverageMap = {};
    let migrated = false;
    for (const [rawKey, tokens] of Object.entries(stored)) {
      const key = normalizeGridKey(rawKey);
      if (key !== rawKey) migrated = true;
      const occupants = cells[key];
      if (!occupants) {
        cells[key] = [...tokens];
      } else {
        for (const token of tokens) {
          if (!occupants.includes(token)) occupants.push(token);
        }
      }
    }
    return { cells, migrated };
  }

  private async loadActivity(): Promise<DeviceActivity> {
    return (await this.ctx.storage.get<DeviceActivity>(ACTIVITY_KEY)) ?? {};
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

  /**
   * Queues a token for deletion and takes it out of the push rotation.
   *
   * The reap budget bounds deletes per tick, so a token APNs has rejected can
   * wait several ticks for its turn. Waiting must not cost anything: notifyOnce
   * writes its `notified-*` dedup key only after the push resolves, so a push
   * that throws leaves no dedup key and is retried on the very next tick — and
   * because cells and devices are ordered oldest-first, an uninstalled
   * long-standing user is walked BEFORE live ones. A backlog of dead tokens
   * would otherwise eat PUSH_BUDGET_PER_INVOCATION every tick until it drained,
   * and live users' alerts would be the ones dropped. Cleanup must never outrank
   * an alert.
   *
   * This lives in the Durable Object rather than KV deliberately: it is a flag
   * read once per tick and written at most once per failed push, and DO storage
   * costs neither the 1,000 daily KV writes nor the 1,000 daily deletes.
   *
   * The flag is cleared when the device is actually reaped (via release), when
   * it re-registers (via reserve — evidence it may be alive again), and when
   * reconcile finds it is no longer in KV at all. A live install re-registers on
   * cold launch, on every foreground and after every successful poll, so no live
   * device can stay muted.
   */
  private async flagReap(request: Request): Promise<Response> {
    const { deviceToken } = (await request.json()) as { deviceToken: string };
    const pending = await this.loadPending();
    if (deviceToken in pending) return reply({ ok: true } satisfies { ok: boolean });
    pending[deviceToken] = Date.now();
    await this.ctx.storage.put(PENDING_KEY, pending);
    return reply({ ok: true } satisfies { ok: boolean });
  }

  /** The tokens the cron should skip this tick. One call per tick. */
  private async pendingReaps(): Promise<Response> {
    return reply({ tokens: Object.keys(await this.loadPending()) });
  }

  private async loadPending(): Promise<PendingReaps> {
    return (await this.ctx.storage.get<PendingReaps>(PENDING_KEY)) ?? {};
  }

  private async forgetPending(deviceTokens: string[]): Promise<void> {
    if (deviceTokens.length === 0) return;
    const pending = await this.loadPending();
    let changed = false;
    for (const token of deviceTokens) {
      if (token in pending) {
        delete pending[token];
        changed = true;
      }
    }
    if (changed) await this.ctx.storage.put(PENDING_KEY, pending);
  }

  /** Recent admissions, with anything past the grace window dropped. */
  private async loadRecent(now: number): Promise<RecentAdmissions> {
    const stored = (await this.ctx.storage.get<RecentAdmissions>(RECENT_KEY)) ?? {};
    const live: RecentAdmissions = {};
    for (const [token, entry] of Object.entries(stored)) {
      if (now - entry.at < RECONCILE_GRACE_MS) {
        live[token] = { gridKey: normalizeGridKey(entry.gridKey), at: entry.at };
      }
    }
    return live;
  }

  /**
   * Finds the `count` oldest-renewed dormant cells eligible for eviction at cap.
   *
   * A cell is dormant only when EVERY occupant has a known activity timestamp
   * at least `dormantAfterMs` old and none was admitted within the reconcile
   * grace window. Any cell with an active occupant or unknown timestamp (e.g.
   * before the first post-deploy reconcile populates timestamps from KV) is
   * protected. Returns `null` if fewer than `count` eligible cells exist so
   * callers never partially evict before refusing.
   */
  private findDormantVictims(
    cells: CoverageMap,
    activity: DeviceActivity,
    recent: RecentAdmissions,
    now: number,
    dormantAfterMs: number,
    count: number
  ): string[] | null {
    if (!Number.isFinite(dormantAfterMs) || dormantAfterMs <= 0 || count <= 0) return null;

    const candidates: Array<{ key: string; lastActivity: number }> = [];

    for (const [key, tokens] of Object.entries(cells)) {
      if (tokens.length === 0) continue;

      let cellLastActivity = -Infinity;
      let eligible = true;
      for (const token of tokens) {
        if (token in recent) {
          eligible = false;
          break;
        }
        const ts = activity[token];
        if (typeof ts !== 'number' || !Number.isFinite(ts)) {
          eligible = false;
          break;
        }
        if (ts > cellLastActivity) cellLastActivity = ts;
      }
      if (!eligible) continue;
      if (now - cellLastActivity < dormantAfterMs) continue;

      candidates.push({ key, lastActivity: cellLastActivity });
    }

    if (candidates.length < count) return null;

    candidates.sort((a, b) => {
      if (a.lastActivity !== b.lastActivity) return a.lastActivity - b.lastActivity;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });

    return candidates.slice(0, count).map((c) => c.key);
  }

  /**
   * Admits `deviceToken` into `gridKey`, enforcing both caps.
   *
   * A device that is already in the cell it is asking for is admitted without
   * touching anything, so an existing user can always re-register, move within
   * their cell, or change their lead time even when the service is full. Only a
   * device that is genuinely new to a full cell, or that would open a cell
   * beyond the global cap when no dormant cell can be evicted, is refused.
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
    const {
      gridKey: rawGridKey,
      deviceToken,
      incumbent,
      maxCells,
      maxDevicesPerCell,
      dormantAfterMs = 0,
    } = (await request.json()) as {
      gridKey: string;
      deviceToken: string;
      incumbent?: boolean;
      maxCells: number;
      maxDevicesPerCell: number;
      dormantAfterMs?: number;
    };

    const gridKey = normalizeGridKey(rawGridKey);
    const now = Date.now();
    const { cells, migrated } = await this.load();
    const recent = await this.loadRecent(now);
    const activity = await this.loadActivity();
    let changed = migrated;
    let activityChanged = false;
    let evictedCells: string[] | undefined;
    let evictedTokens: string[] | undefined;

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
          if (deviceToken in activity) {
            delete activity[deviceToken];
            await this.ctx.storage.put(ACTIVITY_KEY, activity);
          }
          if (deviceToken in recent) {
            delete recent[deviceToken];
            await this.ctx.storage.put(RECENT_KEY, recent);
          }
          return reply(this.refusal('cell_at_capacity', cells, gridKey));
        }
        occupants.push(deviceToken);
        changed = true;
      }
    } else {
      if (Object.keys(cells).length >= maxCells && !incumbent) {
        const needed = Object.keys(cells).length - maxCells + 1;
        const victimKeys = this.findDormantVictims(
          cells,
          activity,
          recent,
          now,
          dormantAfterMs,
          needed
        );
        if (victimKeys !== null) {
          evictedCells = victimKeys;
          const evictedTokenSet = new Set<string>();
          for (const victimKey of victimKeys) {
            for (const token of cells[victimKey]) {
              evictedTokenSet.add(token);
              if (token in activity) {
                delete activity[token];
                activityChanged = true;
              }
              delete recent[token];
            }
            delete cells[victimKey];
          }
          evictedTokens = [...evictedTokenSet];
          changed = true;
          logInfo('do.eviction', {
            object: 'CoverageRegistry',
            reason: 'dormant_cells',
            gridKey,
            evictedCells,
            count: evictedCells.length,
            evictedDeviceCount: evictedTokens.length,
          });
        } else {
          if (changed) await this.ctx.storage.put(COVERAGE_KEY, cells);
          if (deviceToken in activity) {
            delete activity[deviceToken];
            await this.ctx.storage.put(ACTIVITY_KEY, activity);
          }
          if (deviceToken in recent) {
            delete recent[deviceToken];
            await this.ctx.storage.put(RECENT_KEY, recent);
          }
          return reply(this.refusal('coverage_at_capacity', cells, gridKey));
        }
      }
      cells[gridKey] = [deviceToken];
      changed = true;
    }

    if (changed) await this.ctx.storage.put(COVERAGE_KEY, cells);

    if (activity[deviceToken] !== now) {
      activity[deviceToken] = now;
      activityChanged = true;
    }
    if (activityChanged) await this.ctx.storage.put(ACTIVITY_KEY, activity);

    recent[deviceToken] = { gridKey, at: now };
    await this.ctx.storage.put(RECENT_KEY, recent);
    await this.forgetPending(evictedTokens ? [deviceToken, ...evictedTokens] : [deviceToken]);

    const admitted: CoverageReply = {
      ok: true,
      cells: Object.keys(cells).length,
      devices: cells[gridKey]?.length ?? 0,
      ...(evictedCells ? { evictedCells, evictedTokens } : {}),
    };
    return reply(admitted);
  }

  private refusal(
    code: 'coverage_at_capacity' | 'cell_at_capacity',
    cells: CoverageMap,
    gridKey: string
  ): CoverageReply {
    const cellCount = Object.keys(cells).length;
    const deviceCount = cells[gridKey]?.length ?? 0;
    logWarn('do.capacity_refused', {
      object: 'CoverageRegistry',
      code,
      gridKey,
      cells: cellCount,
      devices: deviceCount,
    });
    return {
      ok: false,
      code,
      cells: cellCount,
      devices: deviceCount,
    };
  }

  /** Frees whatever cell slot a device holds. Called whenever its record is dropped. */
  private async release(request: Request): Promise<Response> {
    const { deviceToken } = (await request.json()) as { deviceToken: string };
    const now = Date.now();
    const { cells, migrated } = await this.load();

    let changed = migrated;
    for (const [key, tokens] of Object.entries(cells)) {
      const at = tokens.indexOf(deviceToken);
      if (at === -1) continue;
      tokens.splice(at, 1);
      if (tokens.length === 0) delete cells[key];
      changed = true;
    }
    if (changed) await this.ctx.storage.put(COVERAGE_KEY, cells);

    const activity = await this.loadActivity();
    if (deviceToken in activity) {
      delete activity[deviceToken];
      await this.ctx.storage.put(ACTIVITY_KEY, activity);
    }
    await this.forgetRecent(deviceToken, now);
    await this.forgetPending([deviceToken]);

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
    const { coverage, activity: kvActivity = {} } = (await request.json()) as {
      coverage: CoverageMap;
      activity?: DeviceActivity;
    };
    const now = Date.now();

    const next: CoverageMap = {};
    for (const [rawKey, tokens] of Object.entries(coverage)) {
      const key = normalizeGridKey(rawKey);
      const occupants = next[key];
      if (!occupants) {
        next[key] = [...tokens];
      } else {
        for (const token of tokens) {
          if (!occupants.includes(token)) occupants.push(token);
        }
      }
    }

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

    const covered = new Set(Object.values(next).flat());

    // Keep the freshest observed activity timestamp for every covered device:
    // KV supplies `renewedAt ?? registeredAt` (crucial for pre-existing records
    // right after deploy), while `storedActivity` preserves unchanged
    // re-registrations that skipped a KV write.
    const storedActivity = await this.loadActivity();
    const nextActivity: DeviceActivity = {};
    for (const token of covered) {
      let freshest = -Infinity;
      const fromStored = storedActivity[token];
      if (typeof fromStored === 'number' && Number.isFinite(fromStored) && fromStored > freshest) {
        freshest = fromStored;
      }
      const fromKv = kvActivity[token];
      if (typeof fromKv === 'number' && Number.isFinite(fromKv) && fromKv > freshest) {
        freshest = fromKv;
      }
      const fromRecent = recent[token]?.at;
      if (typeof fromRecent === 'number' && Number.isFinite(fromRecent) && fromRecent > freshest) {
        freshest = fromRecent;
      }
      if (Number.isFinite(freshest)) {
        nextActivity[token] = freshest;
      }
    }
    await this.ctx.storage.put(ACTIVITY_KEY, nextActivity);

    // A pending-reap flag only exists to keep the cron from pushing to a token,
    // so once that token is out of the reconciled map it has nothing left to do
    // and would otherwise accumulate forever. Devices still in KV — including
    // the recent admissions merged in above — keep theirs.
    const pending = await this.loadPending();
    const live: PendingReaps = {};
    for (const [token, at] of Object.entries(pending)) {
      if (covered.has(token)) live[token] = at;
    }
    await this.ctx.storage.put(PENDING_KEY, live);

    return reply({ ok: true, cells: Object.keys(next).length, devices: 0 } satisfies CoverageReply);
  }
}
