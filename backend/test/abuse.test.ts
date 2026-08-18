// Tests for the registration abuse gate.
//
// The headline case is the one the security review actually ran against the
// live Worker: 250 fabricated device registrations in 0.47 seconds from one
// client, every one accepted, each planting a permanent grid cell in the cron's
// WeatherKit fan-out. `describe('the 250-registrations-in-0.47s flood')` below
// re-runs that attack against this Worker and asserts it no longer works —
// through the real fetch handler, not a stub.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import worker from '../src/index';
import {
  MAX_GRID_CELLS,
  DEVICE_RECORD_TTL_SECONDS,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_SECONDS,
  resetBurstCounter,
  selectCellsWithinCap,
} from '../src/abuse';
import { Env, GridCell } from '../src/types';
import { KVMock } from './kvMock';

function makeEnv(kv: KVMock): Env {
  return {
    DEVICES: kv as unknown as KVNamespace,
    APPLE_TEAM_ID: 'TEAMID',
    APPLE_KEY_ID: 'KEYID',
    APPLE_PRIVATE_KEY: '',
    WEATHERKIT_SERVICE_ID: 'service',
    APNS_TOPIC: 'topic',
    APNS_ENV: 'sandbox',
  };
}

/** A syntactically valid — and entirely fabricated — 64-char hex device token. */
function fakeToken(n: number): string {
  return n.toString(16).padStart(4, '0').repeat(16);
}

/** Distinct coordinates 0.05 deg apart, so each maps to its own grid cell. */
function coordsForCell(n: number): { lat: number; lon: number } {
  return { lat: 30 + (n % 200) * 0.05, lon: -120 - Math.floor(n / 200) * 0.05 };
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
  resetBurstCounter();
  kv = new KVMock();
  env = makeEnv(kv);
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the 250-registrations-in-0.47s flood', () => {
  it('is cut off after the per-client limit instead of planting 250 devices', async () => {
    const responses = await Promise.all(
      Array.from({ length: 250 }, (_, n) => worker.fetch(registerRequest(n), env))
    );

    const accepted = responses.filter((r) => r.status === 200);
    const throttled = responses.filter((r) => r.status === 429);

    expect(accepted.length).toBeLessThanOrEqual(RATE_LIMIT_MAX_REQUESTS);
    expect(throttled.length).toBe(250 - accepted.length);
    // The whole point: 250 planted cells cost ~1.1M WeatherKit calls/month.
    expect(kv.keysWithPrefix('device:').length).toBe(accepted.length);
    expect(kv.keysWithPrefix('device:').length).toBeLessThanOrEqual(RATE_LIMIT_MAX_REQUESTS);
  });

  it('still holds when KV reads are stale, as they are during a sub-second burst', async () => {
    // Workers KV serves reads from a colo cache with a 60s floor, so during a
    // 0.47s flood every request can read the same pre-flood counter. A
    // KV-only throttle would let all 250 through here.
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

  it('bounds the damage even when the flood comes from 250 different addresses', async () => {
    // A hostile web page can spread the same flood across its visitors, which
    // defeats any per-client limit. The cell cap is what still holds.
    const responses = await Promise.all(
      Array.from({ length: 250 }, (_, n) =>
        worker.fetch(registerRequest(n, { ip: `203.0.113.${n % 250}` }), env)
      )
    );

    expect(responses.filter((r) => r.status === 200).length).toBeGreaterThan(0);

    const cells = new Set(
      kv
        .keysWithPrefix('device:')
        .map((key) => JSON.parse(kv.raw(key)!) as { lat: number; lon: number })
        .map((d) => `${d.lat.toFixed(2)},${d.lon.toFixed(2)}`)
    );
    expect(cells.size).toBeLessThanOrEqual(MAX_GRID_CELLS);
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
    const other = await worker.fetch(registerRequest(500, { cell: 0, ip: '198.51.100.2' }), env);
    expect(other.status).toBe(200);
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
    const brokenEnv = makeEnv(new KVMock({ failing: true }));
    const res = await worker.fetch(registerRequest(1), brokenEnv);
    // The device write itself fails loudly (500), but the gate did not turn a
    // KV outage into a blanket 429 for everyone.
    expect(res.status).not.toBe(429);
  });

  it('still stops a flood when KV is down, because the burst counter needs no KV', async () => {
    const brokenEnv = makeEnv(new KVMock({ failing: true }));
    const responses = await Promise.all(
      Array.from({ length: 250 }, (_, n) => worker.fetch(registerRequest(n), brokenEnv))
    );
    expect(responses.filter((r) => r.status === 429).length).toBeGreaterThan(
      250 - RATE_LIMIT_MAX_REQUESTS - 1
    );
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
    const existing = await worker.fetch(
      registerRequest(900, { cell: 3, ip: '192.0.2.250' }),
      env
    );
    expect(existing.status).toBe(200);

    // And an existing device updating its own settings still works.
    const update = await worker.fetch(registerRequest(3, { cell: 3, ip: '192.0.2.251' }), env);
    expect(update.status).toBe(200);
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

  it('leaves a fleet below the cap completely untouched', () => {
    const cells: GridCell[] = Array.from({ length: MAX_GRID_CELLS }, (_, n) => ({
      gridKey: `${n}.00,0.00`,
      devices: [],
    }));
    const { cells: served, skipped } = selectCellsWithinCap(cells);
    expect(served).toBe(cells);
    expect(skipped).toBe(0);
  });

  it('is small enough that a full service cannot exhaust the WeatherKit quota', () => {
    const cronTicksPerMonth = 144 * 30.44; // */10 * * * * — see wrangler.toml
    expect(MAX_GRID_CELLS * cronTicksPerMonth).toBeLessThan(500_000);
    // And small enough for the Free plan's 50-subrequest ceiling per invocation.
    expect(MAX_GRID_CELLS).toBeLessThanOrEqual(50);
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
