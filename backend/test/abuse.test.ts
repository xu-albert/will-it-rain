// Tests for the registration abuse gate.
//
// The headline case is the one the security review actually ran against the
// Worker: 250 fabricated device registrations in 0.47 seconds from one client,
// every one accepted, each planting a permanent grid cell in the cron's
// WeatherKit fan-out. `describe('the 250-registrations-in-0.47s flood')` below
// re-runs that attack against this Worker and asserts it no longer works —
// through the real fetch handler, and through the real Durable Object classes,
// not a stub of the gate itself.

import { describe, expect, it, beforeAll, beforeEach, vi } from 'vitest';
import worker, { CoverageRegistry, RegistrationLimiter } from '../src/index';
import {
  MAX_DEVICES_PER_CELL,
  MAX_DEVICE_RECORDS,
  MAX_GRID_CELLS,
  DEVICE_RECORD_REFRESH_SECONDS,
  DEVICE_RECORD_TTL_SECONDS,
  INTERNAL_SUBREQUESTS_PER_DEVICE,
  INTERNAL_SUBREQUESTS_PER_TICK_FIXED,
  INTERNAL_SUBREQUEST_CEILING,
  PUSH_BUDGET_PER_INVOCATION,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_SECONDS,
  createPushBudget,
  reconcileCoverage,
  selectCellsWithinCap,
} from '../src/abuse';
import { DeviceRegistration, Env, GridCell } from '../src/types';
import { KVMock } from './kvMock';
import { DurableObjectNamespaceMock } from './doMock';

interface Harness {
  env: Env;
  kv: KVMock;
  limiter: DurableObjectNamespaceMock;
  coverage: DurableObjectNamespaceMock;
}

// A throwaway P-256 key, so the cron's JWT signing actually succeeds and the
// tick can reach a real push. With APPLE_PRIVATE_KEY empty, importKey throws
// and every grid dies in the per-grid catch long before any push is attempted.
let signingKey = '';

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer;
  signingKey = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
});

function makeHarness(
  options: { kv?: KVMock; failingDurableObjects?: boolean; signingKey?: string } = {}
): Harness {
  const kv = options.kv ?? new KVMock();
  const doOptions = { failing: options.failingDurableObjects };
  const limiter = new DurableObjectNamespaceMock(RegistrationLimiter, doOptions);
  const coverage = new DurableObjectNamespaceMock(CoverageRegistry, doOptions);

  const env: Env = {
    DEVICES: kv as unknown as KVNamespace,
    REGISTRATION_LIMITER: limiter as unknown as DurableObjectNamespace,
    COVERAGE: coverage as unknown as DurableObjectNamespace,
    APPLE_TEAM_ID: 'TEAMID',
    APPLE_KEY_ID: 'KEYID',
    APPLE_PRIVATE_KEY: options.signingKey ?? '',
    WEATHERKIT_SERVICE_ID: 'service',
    APNS_TOPIC: 'topic',
    APNS_ENV: 'sandbox',
  };

  return { env, kv, limiter, coverage };
}

/** A syntactically valid — and entirely fabricated — 64-char hex device token. */
function fakeToken(n: number): string {
  return n.toString(16).padStart(4, '0').repeat(16);
}

/** Distinct coordinates 0.05 deg apart, so each maps to its own grid cell. */
function coordsForCell(n: number): { lat: number; lon: number } {
  return { lat: 30 + (n % 200) * 0.05, lon: -120 - Math.floor(n / 200) * 0.05 };
}

/** A device registration whose only interesting property is when it was first seen. */
function device(n: number, registeredAt: string): DeviceRegistration {
  return { token: fakeToken(n), lat: 0, lon: 0, leadTimeMinutes: 20, registeredAt };
}

function registerRequest(
  n: number,
  options: { ip?: string; contentType?: string; cell?: number } = {}
): Request {
  const { lat, lon } = coordsForCell(options.cell ?? n);
  return new Request('https://worker.test/register', {
    method: 'POST',
    headers: {
      'Content-Type': options.contentType ?? 'application/json',
      'CF-Connecting-IP': options.ip ?? '198.51.100.7',
    },
    body: JSON.stringify({ token: fakeToken(n), lat, lon, leadTimeMinutes: 20 }),
  });
}

let kv: KVMock;
let env: Env;

beforeEach(() => {
  const harness = makeHarness();
  kv = harness.kv;
  env = harness.env;
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

/** The distinct grid cells the stored `device:` records add up to. */
function storedCells(store: KVMock): Set<string> {
  return new Set(
    store
      .keysWithPrefix('device:')
      .map((key) => JSON.parse(store.raw(key)!) as { lat: number; lon: number })
      .map((d) => `${d.lat.toFixed(2)},${d.lon.toFixed(2)}`)
  );
}

describe('the 250-registrations-in-0.47s flood', () => {
  it('is cut off after the per-client limit instead of planting 250 devices', async () => {
    const responses = await Promise.all(
      Array.from({ length: 250 }, (_, n) => worker.fetch(registerRequest(n), env))
    );

    const accepted = responses.filter((r) => r.status === 200);
    const throttled = responses.filter((r) => r.status === 429);
    const atCapacity = responses.filter((r) => r.status === 503);

    // The throttle stops most of it; whatever it lets through still has to fit
    // inside the coverage cap, which is the tighter of the two.
    expect(throttled.length).toBe(250 - RATE_LIMIT_MAX_REQUESTS);
    expect(accepted.length).toBe(MAX_GRID_CELLS);
    expect(atCapacity.length).toBe(RATE_LIMIT_MAX_REQUESTS - MAX_GRID_CELLS);
    // The whole point: 250 planted cells cost ~1.1M WeatherKit calls/month.
    expect(kv.keysWithPrefix('device:').length).toBe(accepted.length);
    expect(storedCells(kv).size).toBeLessThanOrEqual(MAX_GRID_CELLS);
  });

  it('still holds when KV reads are stale, as they are during a sub-second burst', async () => {
    // Workers KV serves reads from a colo cache with a 60s floor, so during a
    // 0.47s flood every request can read the same pre-flood value. The gate
    // counts in a Durable Object precisely so that cannot matter.
    kv.freezeReads();

    const responses = await Promise.all(
      Array.from({ length: 250 }, (_, n) => worker.fetch(registerRequest(n), env))
    );

    const accepted = responses.filter((r) => r.status === 200);
    expect(accepted.length).toBeLessThanOrEqual(RATE_LIMIT_MAX_REQUESTS);
  });

  it('tells the throttled caller what happened and when to retry', async () => {
    const responses = await Promise.all(
      Array.from({ length: 250 }, (_, n) => worker.fetch(registerRequest(n), env))
    );
    const rejected = responses.find((r) => r.status === 429)!;

    const retryAfter = Number(rejected.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(RATE_LIMIT_WINDOW_SECONDS);

    const body = (await rejected.json()) as { error: string; code: string };
    expect(body.code).toBe('rate_limited');
    expect(body.error).toMatch(/retry/i);
  });

  it('holds the cell cap exactly when the flood is spread across 250 addresses', async () => {
    // A hostile web page can spread the same flood across its visitors, which
    // defeats any per-client limit — every request lands in a different
    // throttle bucket. The coverage registry is the thing that still holds, and
    // it holds exactly, not approximately: these 250 registrations are issued
    // concurrently and all reach the one instance that owns the tally.
    const responses = await Promise.all(
      Array.from({ length: 250 }, (_, n) =>
        worker.fetch(registerRequest(n, { ip: `203.0.113.${n % 250}` }), env)
      )
    );

    expect(responses.filter((r) => r.status === 200).length).toBe(MAX_GRID_CELLS);
    expect(responses.filter((r) => r.status === 503).length).toBe(250 - MAX_GRID_CELLS);
    expect(storedCells(kv).size).toBe(MAX_GRID_CELLS);
  });
});

describe('per-client rate limit', () => {
  it('allows a real user their whole budget and then refuses', async () => {
    for (let n = 0; n < RATE_LIMIT_MAX_REQUESTS; n++) {
      const res = await worker.fetch(registerRequest(n, { cell: 0 }), env);
      expect(res.status).toBe(200);
    }
    const overflow = await worker.fetch(registerRequest(99, { cell: 0 }), env);
    expect(overflow.status).toBe(429);
  });

  it('budgets each client separately', async () => {
    for (let n = 0; n < RATE_LIMIT_MAX_REQUESTS + 5; n++) {
      await worker.fetch(registerRequest(n, { cell: 0, ip: '198.51.100.1' }), env);
    }
    // A different cell, so this asserts the throttle and not one of the caps.
    const other = await worker.fetch(registerRequest(500, { cell: 1, ip: '198.51.100.2' }), env);
    expect(other.status).toBe(200);
  });

  it('tears down an unregistered token without spending any KV writes on it', async () => {
    // /unregister is deliberately unthrottled, so this is the cheapest request
    // an attacker can make. It must stay cheap for us too: four KV deletes each
    // would drain the Free plan's daily delete allowance in one 250-request
    // burst and break teardown for real users for the rest of the day.
    const before = kv.deletes;
    for (let n = 0; n < 25; n++) {
      const res = await worker.fetch(
        new Request('https://worker.test/unregister', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `203.0.113.${n}` },
          body: JSON.stringify({ token: fakeToken(700 + n) }),
        }),
        env
      );
      expect(res.status).toBe(200);
    }
    expect(kv.deletes).toBe(before);
  });

  it('still tears down a registration that really exists', async () => {
    await worker.fetch(registerRequest(1, { cell: 0 }), env);
    expect(kv.raw(`device:${fakeToken(1)}`)).toBeTruthy();

    const res = await worker.fetch(
      new Request('https://worker.test/unregister', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.7' },
        body: JSON.stringify({ token: fakeToken(1) }),
      }),
      env
    );

    expect(res.status).toBe(200);
    expect(kv.raw(`device:${fakeToken(1)}`)).toBeUndefined();
  });

  it('does not throttle a user tearing their registration down', async () => {
    for (let n = 0; n < RATE_LIMIT_MAX_REQUESTS + 5; n++) {
      await worker.fetch(registerRequest(n, { cell: 0 }), env);
    }
    const res = await worker.fetch(
      new Request('https://worker.test/unregister', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.7' },
        body: JSON.stringify({ token: fakeToken(0) }),
      }),
      env
    );
    expect(res.status).toBe(200);
  });

  it('keeps working for real users when KV is down, rather than locking them out', async () => {
    const broken = makeHarness({ kv: new KVMock({ failing: true }) });
    const res = await worker.fetch(registerRequest(1), broken.env);
    // The storage failure is reported honestly and retryably, but the gate did
    // not turn a KV outage into a blanket 429 for everyone.
    expect(res.status).not.toBe(429);
    expect(((await res.json()) as { code: string }).code).toBe('storage_unavailable');
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });

  it('still stops a flood when KV is down, because the counters are not in KV', async () => {
    const broken = makeHarness({ kv: new KVMock({ failing: true }) });
    const responses = await Promise.all(
      Array.from({ length: 250 }, (_, n) => worker.fetch(registerRequest(n), broken.env))
    );
    expect(responses.filter((r) => r.status === 429).length).toBe(250 - RATE_LIMIT_MAX_REQUESTS);
  });

  it('lets registrations through when the counters themselves are unreachable', async () => {
    // Failing open is deliberate: an infrastructure blip must not lock every
    // real user out. The cron-side cap is what protects the quota meanwhile.
    const degraded = makeHarness({ failingDurableObjects: true });
    const res = await worker.fetch(registerRequest(1), degraded.env);
    expect(res.status).toBe(200);
  });
});

describe('grid-cell cap', () => {
  // Registering from a fresh address each time takes the rate limit out of the
  // picture, isolating the cap.
  const registerCell = (n: number) =>
    worker.fetch(registerRequest(n, { cell: n, ip: `192.0.2.${n % 250}` }), env);

  it('accepts cells up to the cap and refuses the one after it', async () => {
    for (let n = 0; n < MAX_GRID_CELLS; n++) {
      expect((await registerCell(n)).status).toBe(200);
    }

    const overflow = await registerCell(MAX_GRID_CELLS);
    expect(overflow.status).toBe(503);

    const body = (await overflow.json()) as { code: string; error: string; maxGridCells: number };
    expect(body.code).toBe('coverage_at_capacity');
    expect(body.maxGridCells).toBe(MAX_GRID_CELLS);
    expect(body.error).toMatch(/coverage limit/i);
    expect(overflow.headers.get('Retry-After')).toBeTruthy();
  });

  it('never turns away a user whose area is already covered', async () => {
    for (let n = 0; n < MAX_GRID_CELLS; n++) {
      await registerCell(n);
    }
    expect((await registerCell(MAX_GRID_CELLS)).status).toBe(503);

    // Same coordinates as an existing cell, different device: costs nothing.
    const existing = await worker.fetch(registerRequest(900, { cell: 3, ip: '192.0.2.250' }), env);
    expect(existing.status).toBe(200);

    // And an existing device updating its own settings still works.
    const update = await worker.fetch(registerRequest(3, { cell: 3, ip: '192.0.2.251' }), env);
    expect(update.status).toBe(200);
  });

  it('frees the slot again when the last device in a cell unregisters', async () => {
    for (let n = 0; n < MAX_GRID_CELLS; n++) {
      expect((await registerCell(n)).status).toBe(200);
    }
    expect((await registerCell(MAX_GRID_CELLS)).status).toBe(503);

    await worker.fetch(
      new Request('https://worker.test/unregister', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.200' },
        body: JSON.stringify({ token: fakeToken(0) }),
      }),
      env
    );

    // The vacated cell is no longer held, so a genuinely new area fits again.
    expect((await registerCell(MAX_GRID_CELLS)).status).toBe(200);
  });

  it('clears the caller’s old registration rather than leaving it at stale coordinates', async () => {
    // A user registered in a covered area, who then moves somewhere the service
    // cannot afford to cover, must not keep getting alerts for where they were.
    for (let n = 0; n < MAX_GRID_CELLS; n++) {
      expect((await registerCell(n)).status).toBe(200);
    }
    // A second device shares cell 0, so the mover leaving does not vacate it —
    // otherwise the service would simply have room for the new area.
    expect(
      (await worker.fetch(registerRequest(700, { cell: 0, ip: '192.0.2.239' }), env)).status
    ).toBe(200);
    expect(kv.raw(`device:${fakeToken(0)}`)).toBeTruthy();

    const moved = await worker.fetch(
      registerRequest(0, { cell: 900, ip: '192.0.2.240' }),
      env
    );
    expect(moved.status).toBe(503);
    expect(((await moved.json()) as { error: string }).error).toMatch(/cleared/i);
    expect(kv.raw(`device:${fakeToken(0)}`)).toBeUndefined();
  });

  it('refuses an unregistered token without spending any KV writes on it', async () => {
    for (let n = 0; n < MAX_GRID_CELLS; n++) {
      expect((await registerCell(n)).status).toBe(200);
    }

    // The flood case: fabricated tokens that were never registered. Refusing
    // has to cost less than admitting, or the gate becomes a KV-delete
    // amplifier against the Free plan's daily allowance.
    const before = kv.deletes;
    for (let n = 0; n < 20; n++) {
      const refused = await worker.fetch(
        registerRequest(600 + n, { cell: 900 + n, ip: `192.0.2.${100 + n}` }),
        env
      );
      expect(refused.status).toBe(503);
    }
    expect(kv.deletes).toBe(before);
  });

  it('frees a vacated cell for good, rather than resurrecting it at the next tick', async () => {
    // The grace window that protects a just-registered device from an
    // eventually-consistent snapshot must not also protect a device that has
    // since left. A cell whose last device unregistered is genuinely free, and
    // reconcile re-adding it would hold the slot against a real user — who is
    // then refused AND has their record deleted.
    for (let n = 0; n < MAX_GRID_CELLS; n++) {
      expect((await registerCell(n)).status).toBe(200);
    }

    await worker.fetch(
      new Request('https://worker.test/unregister', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.200' },
        body: JSON.stringify({ token: fakeToken(0) }),
      }),
      env
    );

    // A cron tick lands while that departure is still inside the grace window.
    const remaining = kv.keysWithPrefix('device:');
    await reconcileCoverage(
      remaining.map((key) => {
        const record = JSON.parse(kv.raw(key)!) as { token: string; lat: number; lon: number };
        return {
          gridKey: `${record.lat.toFixed(2)},${record.lon.toFixed(2)}`,
          devices: [record as never],
        };
      }),
      env
    );

    const newcomer = await worker.fetch(
      registerRequest(900, { cell: 900, ip: '192.0.2.232' }),
      env
    );
    expect(newcomer.status).toBe(200);
  });

  it('never refuses an incumbent, even after a stale cron snapshot loses its cell', async () => {
    // Workers KV `list` is eventually consistent, so the cron can read a
    // snapshot taken before the newest registration landed. Reconciling that
    // snapshot verbatim used to evict the newcomer from the tally; a later
    // arrival then took the freed slot, and when the original device
    // re-registered on foreground it was refused AND had its record deleted —
    // a live user silently and permanently deregistered.
    for (let n = 0; n < MAX_GRID_CELLS; n++) {
      expect((await registerCell(n)).status).toBe(200);
    }

    // A cron tick whose device listing predates the last registration.
    const stale = kv.keysWithPrefix('device:').filter((k) => k !== `device:${fakeToken(14)}`);
    await reconcileCoverage(
      stale.map((key) => {
        const record = JSON.parse(kv.raw(key)!) as { token: string; lat: number; lon: number };
        return {
          gridKey: `${record.lat.toFixed(2)},${record.lon.toFixed(2)}`,
          devices: [record as never],
        };
      }),
      env
    );

    // Whatever the tally now believes, the fleet really is at capacity, so a
    // genuinely new area is still refused.
    const newcomer = await worker.fetch(
      registerRequest(800, { cell: 800, ip: '192.0.2.231' }),
      env
    );
    expect(newcomer.status).toBe(503);

    // And the incumbent, whose record never went anywhere, is still admitted.
    const again = await worker.fetch(registerRequest(14, { cell: 14, ip: '192.0.2.230' }), env);
    expect(again.status).toBe(200);
    expect(kv.raw(`device:${fakeToken(14)}`)).toBeTruthy();
  });

  it('never refuses an incumbent even once the tally has genuinely lost its cell', async () => {
    // The grace window above covers a snapshot taken seconds before the tick.
    // Past it, the tally really can drop a device that is still in KV, and the
    // only thing left standing between a live user and having their
    // registration deleted is that a stored record at this exact cell is proof
    // enough on its own.
    for (let n = 0; n < MAX_GRID_CELLS; n++) {
      expect((await registerCell(n)).status).toBe(200);
    }

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 5 * 60_000);

      const stale = kv.keysWithPrefix('device:').filter((k) => k !== `device:${fakeToken(14)}`);
      await reconcileCoverage(
        stale.map((key) => {
          const record = JSON.parse(kv.raw(key)!) as { token: string; lat: number; lon: number };
          return {
            gridKey: `${record.lat.toFixed(2)},${record.lon.toFixed(2)}`,
            devices: [record as never],
          };
        }),
        env
      );

      // The tally now has a free slot it should not have, and a newcomer takes it.
      expect(
        (await worker.fetch(registerRequest(800, { cell: 800, ip: '192.0.2.231' }), env)).status
      ).toBe(200);

      // Device 14 is still registered in KV at its own unchanged cell, so it is
      // an incumbent and must be admitted — not refused and deleted.
      const again = await worker.fetch(registerRequest(14, { cell: 14, ip: '192.0.2.230' }), env);
      expect(again.status).toBe(200);
      expect(kv.raw(`device:${fakeToken(14)}`)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a new device once a single cell is full, and says which limit it hit', async () => {
    for (let n = 0; n < MAX_DEVICES_PER_CELL; n++) {
      const res = await worker.fetch(registerRequest(n, { cell: 7, ip: `192.0.2.${n}` }), env);
      expect(res.status).toBe(200);
    }

    const overflow = await worker.fetch(
      registerRequest(800, { cell: 7, ip: '192.0.2.201' }),
      env
    );
    expect(overflow.status).toBe(503);

    const body = (await overflow.json()) as { code: string; maxDevicesPerCell: number };
    expect(body.code).toBe('cell_at_capacity');
    expect(body.maxDevicesPerCell).toBe(MAX_DEVICES_PER_CELL);
    expect(overflow.headers.get('Retry-After')).toBeTruthy();

    // A device already in that cell is still never refused.
    const incumbent = await worker.fetch(registerRequest(0, { cell: 7, ip: '192.0.2.202' }), env);
    expect(incumbent.status).toBe(200);
  });

  it('caps the cron fan-out no matter what the registration side let through', async () => {
    const cells: GridCell[] = Array.from({ length: 400 }, (_, n) => ({
      gridKey: `${n}.00,0.00`,
      devices: [
        {
          token: fakeToken(n),
          lat: n,
          lon: 0,
          leadTimeMinutes: 20,
          // Descending timestamps: cell 0 is the newest, cell 399 the oldest.
          registeredAt: new Date(Date.UTC(2026, 0, 1) - n * 1000).toISOString(),
        },
      ],
    }));

    const { cells: served, skipped } = selectCellsWithinCap(cells);

    expect(served.length).toBe(MAX_GRID_CELLS);
    expect(skipped).toBe(400 - MAX_GRID_CELLS);
    // Oldest registrations keep their alerts; a flood of newcomers cannot
    // displace the users who were already here.
    expect(served[0].gridKey).toBe('399.00,0.00');
    expect(served.map((c) => c.gridKey)).not.toContain('0.00,0.00');
  });

  it('breaks ties on equal registration times deterministically', () => {
    const sameInstant = new Date(Date.UTC(2026, 0, 1)).toISOString();
    const cells: GridCell[] = Array.from({ length: MAX_GRID_CELLS + 5 }, (_, n) => ({
      gridKey: `cell-${String(n).padStart(3, '0')}`,
      devices: [
        { token: fakeToken(n), lat: 0, lon: 0, leadTimeMinutes: 20, registeredAt: sameInstant },
      ],
    }));

    const first = selectCellsWithinCap(cells).cells.map((c) => c.gridKey);
    const second = selectCellsWithinCap([...cells].reverse()).cells.map((c) => c.gridKey);
    expect(first).toEqual(second);
  });

  it('serves a fleet below the cap in full', () => {
    const cells: GridCell[] = Array.from({ length: MAX_GRID_CELLS }, (_, n) => ({
      gridKey: `${n}.00,0.00`,
      devices: [],
    }));
    const { cells: served, skipped } = selectCellsWithinCap(cells);
    expect(served.map((c) => c.gridKey).sort()).toEqual(cells.map((c) => c.gridKey).sort());
    expect(skipped).toBe(0);
  });

  it('orders cells oldest-first even when nothing has to be skipped', () => {
    // Below the cap the list used to come back in KV order — `device:<token-hex>`
    // — which is arbitrary with respect to who registered first and identical on
    // every tick. The push budget is spent walking this list, so that handed the
    // same devices the same shortfall forever.
    const cells: GridCell[] = [
      { gridKey: 'newest', devices: [device(1, '2026-03-01T00:00:00.000Z')] },
      { gridKey: 'oldest', devices: [device(2, '2026-01-01T00:00:00.000Z')] },
      { gridKey: 'middle', devices: [device(3, '2026-02-01T00:00:00.000Z')] },
    ];

    const { cells: served, skipped } = selectCellsWithinCap(cells);
    expect(served.map((c) => c.gridKey)).toEqual(['oldest', 'middle', 'newest']);
    expect(skipped).toBe(0);
  });

  it('orders devices inside a cell oldest-first, so the budget starves newcomers', () => {
    // One cell can hold up to MAX_DEVICES_PER_CELL devices and the budget is
    // spent per device, so ordering within a cell decides who goes unnotified
    // just as much as ordering between cells does.
    const cells: GridCell[] = [
      {
        gridKey: 'one-cell',
        devices: [
          device(1, '2026-03-01T00:00:00.000Z'),
          device(2, '2026-01-01T00:00:00.000Z'),
          device(3, '2026-02-01T00:00:00.000Z'),
        ],
      },
    ];

    const served = selectCellsWithinCap(cells).cells[0].devices;
    expect(served.map((d) => d.registeredAt)).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z',
      '2026-03-01T00:00:00.000Z',
    ]);
  });
});

describe('the cron fan-out budget', () => {
  const cronTicksPerMonth = 144 * 30.44; // */10 * * * * — see wrangler.toml

  it('fits a full service inside the Free plan’s 50 external subrequests', () => {
    // One WeatherKit fetch per cell, plus up to two pushes per notified device,
    // out of one shared per-invocation pool. Counting only the fetches — which
    // is what the first version of this cap did — is what let the 51st
    // subrequest be an APNs push that throws.
    expect(MAX_GRID_CELLS + PUSH_BUDGET_PER_INVOCATION).toBeLessThanOrEqual(50);
  });

  it('bounds the devices one tick reads, so the internal subrequest budget holds', () => {
    // Counting only readCoverage's one get per record would permit roughly twice
    // the devices the budget really allows: every device also pays a `notified-*`
    // dedup get, and that read happens before the push budget is consulted, so
    // it is charged whether or not the device is notified. At 15 x 32 the
    // readCoverage-only figure is still 480 of 1,000 while the real tick spends
    // 1,001 — and subrequest 1,001 throws into a per-grid catch that only logs.
    const perTick =
      INTERNAL_SUBREQUESTS_PER_DEVICE * MAX_DEVICE_RECORDS + INTERNAL_SUBREQUESTS_PER_TICK_FIXED;
    expect(perTick).toBeLessThanOrEqual(INTERNAL_SUBREQUEST_CEILING);
  });

  it('is small enough that a full service cannot exhaust the WeatherKit quota', () => {
    expect(MAX_GRID_CELLS * cronTicksPerMonth).toBeLessThan(500_000);
  });

  it('stops spending once exhausted, and counts what it refused', () => {
    const budget = createPushBudget(3);
    expect([budget.spend(), budget.spend(), budget.spend()]).toEqual([true, true, true]);
    expect(budget.spend()).toBe(false);
    expect(budget.spend()).toBe(false);
    expect(budget.spent).toBe(3);
    expect(budget.denied).toBe(2);
  });
});

describe('a cron tick that wants more pushes than the plan allows', () => {
  // The scenario the cap exists for: every covered cell has rain arriving, and
  // every device in them is due an alert. Before the budget, the tick issued a
  // WeatherKit fetch per cell and then a push per device until the runtime threw
  // "Too many subrequests" — which lands in a per-grid catch that only logs, so
  // the tick reported success while an arbitrary subset of users got nothing.

  /** Rain starting ~10 minutes out, dry before that: fires the rain-START path. */
  function rainStartingSoon(now: number): unknown {
    return {
      forecastNextHour: {
        minutes: Array.from({ length: 60 }, (_, i) => ({
          startTime: new Date(now + i * 60_000).toISOString(),
          precipitationChance: i >= 10 ? 0.9 : 0,
          precipitationIntensity: i >= 10 ? 2 : 0,
        })),
      },
    };
  }

  /** Raining now, stopping in ~10 minutes: fires the rain-END path. */
  function rainStoppingSoon(now: number): unknown {
    return {
      forecastNextHour: {
        minutes: Array.from({ length: 60 }, (_, i) => ({
          startTime: new Date(now + i * 60_000).toISOString(),
          precipitationChance: i < 10 ? 0.9 : 0,
          precipitationIntensity: i < 10 ? 2 : 0,
        })),
      },
    };
  }

  interface Tick {
    weatherFetches: number;
    pushes: number;
    externalSubrequests: number;
  }

  /**
   * Runs the real scheduled() handler over `cells` x `devicesPerCell` planted
   * devices, counting every outbound request the way the Workers runtime counts
   * external subrequests.
   */
  async function runCron(options: {
    cells: number;
    devicesPerCell: number;
    forecast: (now: number) => unknown;
    withActivityToken?: boolean;
  }): Promise<Tick> {
    const harness = makeHarness({ signingKey });
    const now = Date.now();

    let token = 0;
    for (let cell = 0; cell < options.cells; cell++) {
      const { lat, lon } = coordsForCell(cell);
      for (let n = 0; n < options.devicesPerCell; n++) {
        const deviceToken = fakeToken(token++);
        await harness.kv.put(
          `device:${deviceToken}`,
          JSON.stringify({
            token: deviceToken,
            lat,
            lon,
            leadTimeMinutes: 30,
            registeredAt: new Date(now - token * 1000).toISOString(),
            ...(options.withActivityToken ? { activityToken: deviceToken } : {}),
          }),
          { expirationTtl: DEVICE_RECORD_TTL_SECONDS }
        );
      }
    }

    const tick: Tick = { weatherFetches: 0, pushes: 0, externalSubrequests: 0 };
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      tick.externalSubrequests += 1;
      if (url.includes('weatherkit.apple.com')) {
        tick.weatherFetches += 1;
        return new Response(JSON.stringify(options.forecast(now)), { status: 200 });
      }
      if (url.includes('push.apple.com')) {
        tick.pushes += 1;
        return new Response('', { status: 200 });
      }
      throw new Error(`Unexpected outbound request to ${url}`);
    });

    try {
      await worker.scheduled({} as ScheduledEvent, harness.env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      } as unknown as ExecutionContext);
    } finally {
      vi.unstubAllGlobals();
    }

    return tick;
  }

  it('sends every alert it can afford and no more', async () => {
    // 15 cells x 5 devices = 75 devices all due a rain-start alert, against a
    // budget of 34.
    const tick = await runCron({
      cells: MAX_GRID_CELLS,
      devicesPerCell: 5,
      forecast: rainStartingSoon,
    });

    expect(tick.weatherFetches).toBe(MAX_GRID_CELLS);
    expect(tick.pushes).toBe(PUSH_BUDGET_PER_INVOCATION);
    // The invariant the whole cap exists to protect: one invocation, one Free
    // plan's worth of external subrequests.
    expect(tick.externalSubrequests).toBeLessThanOrEqual(50);
  });

  it('counts a Live Activity update against the same budget as the alert', async () => {
    // Each device now wants two external pushes, so the budget runs out in half
    // as many devices — and the Live Activity push has to be what stops, not the
    // subrequest limit.
    const tick = await runCron({
      cells: MAX_GRID_CELLS,
      devicesPerCell: 5,
      forecast: rainStartingSoon,
      withActivityToken: true,
    });

    expect(tick.pushes).toBe(PUSH_BUDGET_PER_INVOCATION);
    expect(tick.externalSubrequests).toBeLessThanOrEqual(50);
  });

  it('holds the budget on the rain-ending path too', async () => {
    const tick = await runCron({
      cells: MAX_GRID_CELLS,
      devicesPerCell: 5,
      forecast: rainStoppingSoon,
      withActivityToken: true,
    });

    expect(tick.pushes).toBe(PUSH_BUDGET_PER_INVOCATION);
    expect(tick.externalSubrequests).toBeLessThanOrEqual(50);
  });

  it('says out loud how many devices it could not notify', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });

    await runCron({ cells: MAX_GRID_CELLS, devicesPerCell: 5, forecast: rainStartingSoon });

    // 75 devices wanted an alert, 34 got one. Exhaustion must never be silent —
    // recordPushFailure ignores anything that is not an APNsError, so a
    // subrequest overflow would otherwise vanish.
    const exhausted = errors.find((line) => line.includes('Push budget exhausted'));
    expect(exhausted).toBeDefined();
    expect(exhausted).toContain(`dropped ${75 - PUSH_BUDGET_PER_INVOCATION}`);
  });

  it('gives every tick its own budget rather than a shared one', async () => {
    // Each tick has to want more than the budget on its own. Two small ticks
    // would prove nothing: 10 pushes then 10 more still fit inside 34 whether
    // the budget is per-invocation or hoisted to module scope. Sized like this,
    // a shared budget spends it all on the first tick and sends nothing at all
    // on the second.
    const first = await runCron({
      cells: MAX_GRID_CELLS,
      devicesPerCell: 5,
      forecast: rainStartingSoon,
    });
    const second = await runCron({
      cells: MAX_GRID_CELLS,
      devicesPerCell: 5,
      forecast: rainStartingSoon,
    });

    expect(first.pushes).toBe(PUSH_BUDGET_PER_INVOCATION);
    expect(second.pushes).toBe(PUSH_BUDGET_PER_INVOCATION);
  });
});

describe('registration records expire', () => {
  it('writes device records with a TTL so unrefreshed junk evaporates', async () => {
    await worker.fetch(registerRequest(1), env);
    const ttl = kv.ttlSeconds(`device:${fakeToken(1)}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(DEVICE_RECORD_TTL_SECONDS);
    expect(ttl).toBeGreaterThan(DEVICE_RECORD_TTL_SECONDS - 60);
  });

  it('skips the write when the request repeats what is already stored', async () => {
    await worker.fetch(registerRequest(1, { cell: 0 }), env);
    const afterFirst = kv.puts;

    // The client sends this same body on every cold launch, every foreground and
    // after every successful poll. Writing each one would spend the day's KV
    // allowance on nothing.
    await worker.fetch(registerRequest(1, { cell: 0 }), env);
    await worker.fetch(registerRequest(1, { cell: 0 }), env);
    expect(kv.puts).toBe(afterFirst);
  });

  it('still writes when the request actually changes something', async () => {
    await worker.fetch(registerRequest(1, { cell: 0 }), env);
    const afterFirst = kv.puts;

    await worker.fetch(registerRequest(1, { cell: 1 }), env);
    expect(kv.puts).toBeGreaterThan(afterFirst);

    const stored = JSON.parse(kv.raw(`device:${fakeToken(1)}`)!) as { lat: number };
    expect(stored.lat).toBe(coordsForCell(1).lat);
  });

  it('never lets an active device expire, however long it re-registers unchanged', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      await worker.fetch(registerRequest(1, { cell: 0 }), env);

      const key = `device:${fakeToken(1)}`;
      const firstSeen = (JSON.parse(kv.raw(key)!) as { registeredAt: string }).registeredAt;

      // A device that never moves and never changes a setting, foregrounding
      // once a day for a year. Skipping the identical write is only safe while
      // the staleness refresh still fires, so this fails outright — the record
      // is simply gone from KV — if the refresh threshold is ever raised past
      // the TTL, or if the refresh path is dropped.
      for (let day = 1; day <= 365; day++) {
        vi.advanceTimersByTime(24 * 60 * 60 * 1000);
        const res = await worker.fetch(registerRequest(1, { cell: 0 }), env);
        expect(res.status).toBe(200);
        expect(kv.raw(key), `record expired on day ${day}`).toBeTruthy();
        expect(kv.ttlSeconds(key)).toBeGreaterThan(0);
      }

      // And the ranking key survived every one of those rewrites: restamping it
      // would let a planted record outrank this user.
      expect((JSON.parse(kv.raw(key)!) as { registeredAt: string }).registeredAt).toBe(firstSeen);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes well inside the TTL rather than at its edge', () => {
    expect(DEVICE_RECORD_REFRESH_SECONDS).toBeLessThan(DEVICE_RECORD_TTL_SECONDS);
  });

  it('keeps the TTL when a Live Activity token is attached or cleared', async () => {
    await worker.fetch(registerRequest(1), env);

    const attach = await worker.fetch(
      new Request('https://worker.test/register-activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.7' },
        body: JSON.stringify({ token: fakeToken(1), activityToken: fakeToken(2) }),
      }),
      env
    );
    expect(attach.status).toBe(200);
    expect(kv.ttlSeconds(`device:${fakeToken(1)}`)).toBeGreaterThan(0);

    const detach = await worker.fetch(
      new Request('https://worker.test/unregister-activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.7' },
        body: JSON.stringify({ token: fakeToken(1) }),
      }),
      env
    );
    expect(detach.status).toBe(200);
    expect(kv.ttlSeconds(`device:${fakeToken(1)}`)).toBeGreaterThan(0);
  });

  it('gives pre-TTL records an expiry the next time the cron sees them', async () => {
    // KV only sets an expiry at write time, so records written before the TTL
    // existed are immortal until something rewrites them.
    kv.putWithoutTtl(
      `device:${fakeToken(42)}`,
      JSON.stringify({
        token: fakeToken(42),
        lat: 40,
        lon: -70,
        leadTimeMinutes: 20,
        registeredAt: '2026-01-01T00:00:00.000Z',
      })
    );
    expect(kv.ttlSeconds(`device:${fakeToken(42)}`)).toBeNull();

    await worker.scheduled(
      {} as ScheduledEvent,
      env,
      { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
    );

    expect(kv.ttlSeconds(`device:${fakeToken(42)}`)).toBeGreaterThan(
      DEVICE_RECORD_TTL_SECONDS - 60
    );
  });
});

describe('re-registration', () => {
  const reRegister = (n: number, cell: number) =>
    worker.fetch(registerRequest(n, { cell, ip: '198.51.100.7' }), env);

  it('keeps the Live Activity token the client only ever sends once', async () => {
    await reRegister(1, 0);
    await worker.fetch(
      new Request('https://worker.test/register-activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.7' },
        body: JSON.stringify({ token: fakeToken(1), activityToken: fakeToken(2) }),
      }),
      env
    );

    // The app re-registers after every successful weather poll. Before this,
    // that silently erased the activity token minutes after it arrived.
    await reRegister(1, 0);

    const stored = JSON.parse(kv.raw(`device:${fakeToken(1)}`)!) as {
      activityToken?: string;
      activityUpdatedAt?: string;
    };
    expect(stored.activityToken).toBe(fakeToken(2));
    expect(stored.activityUpdatedAt).toBeTruthy();
  });

  it('keeps the original registeredAt, so cell ranking is genuine first-seen order', async () => {
    await reRegister(1, 0);
    const first = (JSON.parse(kv.raw(`device:${fakeToken(1)}`)!) as { registeredAt: string })
      .registeredAt;

    await reRegister(1, 1);
    const after = JSON.parse(kv.raw(`device:${fakeToken(1)}`)!) as {
      registeredAt: string;
      lat: number;
    };

    // Restamping this would rank an actively-used install as newer than a
    // planted record nobody has touched for days, handing the planted one the
    // scarce cell slot — the exact inversion selectCellsWithinCap promises not
    // to make.
    expect(after.registeredAt).toBe(first);
    // The fields the request does carry still change.
    expect(after.lat).toBe(coordsForCell(1).lat);
  });
});

describe('content type', () => {
  it('refuses the text/plain body a cross-origin page could send without a preflight', async () => {
    const res = await worker.fetch(registerRequest(1, { contentType: 'text/plain' }), env);
    expect(res.status).toBe(415);
    expect(((await res.json()) as { code: string }).code).toBe('unsupported_media_type');
    expect(kv.keysWithPrefix('device:').length).toBe(0);
  });

  it('accepts the charset-qualified header a normal client may send', async () => {
    const res = await worker.fetch(
      registerRequest(1, { contentType: 'application/json; charset=utf-8' }),
      env
    );
    expect(res.status).toBe(200);
  });
});
