import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import {
  formatError,
  isTimeoutError,
  logError,
  logInfo,
  logWarn,
  scrubSensitive,
} from '../src/logger';
import {
  DORMANT_CELL_THRESHOLD_SECONDS,
  MAX_DEVICES_PER_CELL,
  MAX_GRID_CELLS,
  RATE_LIMIT_MAX_REQUESTS,
} from '../src/abuse';
import { RegistrationLimiter } from '../src/durable';
import { coordsForCell, fakeToken, generateSigningKey, makeHarness } from './harness';
import { KVMock } from './kvMock';

interface LogEntry {
  event: string;
  level: 'info' | 'warn' | 'error';
  ts: string;
  [key: string]: unknown;
}

function captureLogs() {
  const raw: string[] = [];
  const entries: LogEntry[] = [];

  const record = (expectedLevel: LogEntry['level']) => (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    raw.push(line);
    // Every emitted log must be single-line valid JSON.
    expect(line).not.toContain('\n');
    const parsed = JSON.parse(line) as LogEntry;
    expect(parsed.level).toBe(expectedLevel);
    expect(typeof parsed.event).toBe('string');
    expect(Number.isNaN(Date.parse(parsed.ts))).toBe(false);
    entries.push(parsed);
  };

  vi.spyOn(console, 'log').mockImplementation(record('info'));
  vi.spyOn(console, 'warn').mockImplementation(record('warn'));
  vi.spyOn(console, 'error').mockImplementation(record('error'));

  return { raw, entries };
}

describe('Structured logger redaction & formatting', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits single-line JSON with base fields and strips forbidden sensitive keys', () => {
    const { entries, raw } = captureLogs();
    const deviceToken = fakeToken(99);
    const activityToken = fakeToken(100);
    const adminToken = 'super-secret-admin-token-value';

    logInfo('test.event', {
      route: '/register',
      gridKey: '37.75,-122.40',
      token: deviceToken,
      deviceToken,
      activityToken,
      adminToken,
      ip: '203.0.113.42',
      lat: 37.774929,
      lon: -122.419416,
      authorization: 'Bearer eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJ0ZXN0In0.sig123',
      detail: `Failed pushing to https://api.push.apple.com/3/device/${deviceToken} with Bearer eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJ0ZXN0In0.sig123`,
    });

    logWarn('test.warn', {
      error: formatError(
        new Error(
          `GET https://weatherkit.apple.com/api/v1/weather/en-US/37.774929/-122.419416 failed for ${activityToken}`
        )
      ),
    });

    logError('test.error', {
      nested: { token: deviceToken, note: `token=${deviceToken}` },
    });

    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      event: 'test.event',
      level: 'info',
      route: '/register',
      gridKey: '37.75,-122.40',
    });
    expect(entries[0]).not.toHaveProperty('token');
    expect(entries[0]).not.toHaveProperty('deviceToken');
    expect(entries[0]).not.toHaveProperty('activityToken');
    expect(entries[0]).not.toHaveProperty('adminToken');
    expect(entries[0]).not.toHaveProperty('ip');
    expect(entries[0]).not.toHaveProperty('lat');
    expect(entries[0]).not.toHaveProperty('lon');
    expect(entries[0]).not.toHaveProperty('authorization');

    const joined = raw.join('\n');
    expect(joined).not.toContain(deviceToken);
    expect(joined).not.toContain(activityToken);
    expect(joined).not.toContain(adminToken);
    expect(joined).not.toContain('203.0.113.42');
    expect(joined).not.toContain('37.774929');
    expect(joined).not.toContain('-122.419416');
    expect(joined).not.toContain('eyJhbGciOiJFUzI1NiJ9');
    expect(scrubSensitive(`https://api.push.apple.com/3/device/${deviceToken}`)).toContain(
      '/3/device/[redacted]'
    );
  });

  it('detects timeout errors across DOMException and standard Error shapes', () => {
    expect(isTimeoutError(new DOMException('timed out', 'TimeoutError'))).toBe(true);
    expect(isTimeoutError(new DOMException('aborted', 'AbortError'))).toBe(true);
    expect(isTimeoutError(new Error('The operation was aborted due to timeout'))).toBe(true);
    expect(isTimeoutError(new Error('HTTP 500 Internal Server Error'))).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
  });
});

describe('Worker HTTP & Durable Object structured logging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs every HTTP request outcome without leaking raw tokens, IPs, admin secrets, or exact coords', async () => {
    const { entries, raw } = captureLogs();
    const harness = makeHarness();
    const adminSecret = 'admin-secret-never-log-me-9999';
    harness.env.ADMIN_TOKEN = adminSecret;

    const deviceToken = fakeToken(11);
    const activityToken = fakeToken(22);
    const clientIp = '203.0.113.42';
    const exactLat = 37.774929;
    const exactLon = -122.419416;

    // 1. Unknown route -> 404
    const notFound = await worker.fetch(
      new Request('https://worker.test/robots.txt', {
        method: 'GET',
        headers: { 'CF-Connecting-IP': clientIp },
      }),
      harness.env
    );
    expect(notFound.status).toBe(404);

    // 2. Admin unauthorized -> 401
    const unauth = await worker.fetch(
      new Request('https://worker.test/test-rain', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': 'wrong-admin-secret-1234',
          'CF-Connecting-IP': clientIp,
        },
        body: JSON.stringify({ token: deviceToken }),
      }),
      harness.env
    );
    expect(unauth.status).toBe(401);

    // 3. Register activity before device exists -> 404
    const act404 = await worker.fetch(
      new Request('https://worker.test/register-activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': clientIp },
        body: JSON.stringify({ token: deviceToken, activityToken }),
      }),
      harness.env
    );
    expect(act404.status).toBe(404);

    // 4. Valid registration -> 200
    const reg200 = await worker.fetch(
      new Request('https://worker.test/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': clientIp },
        body: JSON.stringify({ token: deviceToken, lat: exactLat, lon: exactLon }),
      }),
      harness.env
    );
    expect(reg200.status).toBe(200);

    // 5. Same-cell settings change inside cooldown -> 202
    const reg202 = await worker.fetch(
      new Request('https://worker.test/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': clientIp },
        body: JSON.stringify({
          token: deviceToken,
          lat: exactLat,
          lon: exactLon,
          leadTimeMinutes: 45,
        }),
      }),
      harness.env
    );
    expect(reg202.status).toBe(202);

    // 6. Rate-limit exhaustion -> 429
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
      await worker.fetch(
        new Request('https://worker.test/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': clientIp },
          body: JSON.stringify({ token: deviceToken, lat: exactLat, lon: exactLon }),
        }),
        harness.env
      );
    }
    const throttled = await worker.fetch(
      new Request('https://worker.test/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': clientIp },
        body: JSON.stringify({ token: deviceToken, lat: exactLat, lon: exactLon }),
      }),
      harness.env
    );
    expect(throttled.status).toBe(429);

    const httpLogs = entries.filter((e) => e.event === 'http.request');
    expect(httpLogs.some((e) => e.route === '/robots.txt' && e.status === 404 && e.code === 'not_found')).toBe(true);
    expect(httpLogs.some((e) => e.route === '/test-rain' && e.status === 401 && e.code === 'unauthorized')).toBe(true);
    expect(
      httpLogs.some(
        (e) => e.route === '/register-activity' && e.status === 404 && e.code === 'device_not_registered'
      )
    ).toBe(true);
    expect(
      httpLogs.some(
        (e) =>
          e.route === '/register' &&
          e.status === 200 &&
          e.gridKey === '37.75,-122.40' &&
          typeof e.durationMs === 'number' &&
          typeof e.bucketPrefix === 'string' &&
          (e.bucketPrefix as string).length === 8
      )
    ).toBe(true);
    expect(
      httpLogs.some(
        (e) => e.route === '/register' && e.status === 202 && e.code === 'rewrite_cooldown'
      )
    ).toBe(true);
    expect(
      httpLogs.some(
        (e) =>
          e.route === '/register' &&
          e.status === 429 &&
          e.code === 'rate_limited' &&
          typeof e.bucketPrefix === 'string'
      )
    ).toBe(true);

    const allText = raw.join('\n');
    expect(allText).not.toContain(deviceToken);
    expect(allText).not.toContain(activityToken);
    expect(allText).not.toContain(adminSecret);
    expect(allText).not.toContain('wrong-admin-secret-1234');
    expect(allText).not.toContain(clientIp);
    expect(allText).not.toContain(String(exactLat));
    expect(allText).not.toContain(String(exactLon));
  });

  it('logs 503 storage_unavailable, coverage_at_capacity, cell_at_capacity, and 500 KV write errors', async () => {
    const { entries } = captureLogs();

    // storage_unavailable on KV get error
    const failingGetKv = new KVMock({ failing: true });
    const h1 = makeHarness({ kv: failingGetKv });
    const resStorage = await worker.fetch(
      new Request('https://worker.test/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: fakeToken(1), lat: 37.75, lon: -122.4 }),
      }),
      h1.env
    );
    expect(resStorage.status).toBe(503);
    expect(entries.some((e) => e.event === 'kv.error' && e.op === 'get')).toBe(true);
    expect(
      entries.some(
        (e) => e.event === 'http.request' && e.status === 503 && e.code === 'storage_unavailable'
      )
    ).toBe(true);

    // 500 on KV put error
    const failingPutKv = new KVMock();
    vi.spyOn(failingPutKv, 'put').mockRejectedValue(new Error('KV write quota exceeded'));
    const h2 = makeHarness({ kv: failingPutKv });
    const resPut = await worker.fetch(
      new Request('https://worker.test/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: fakeToken(2), lat: 37.75, lon: -122.4 }),
      }),
      h2.env
    );
    expect(resPut.status).toBe(500);
    expect(entries.some((e) => e.event === 'kv.error' && e.op === 'put')).toBe(true);
    expect(
      entries.some(
        (e) => e.event === 'http.request' && e.status === 500 && e.code === 'kv_write_failed'
      )
    ).toBe(true);

    // coverage_at_capacity & cell_at_capacity
    const h3 = makeHarness();
    for (let i = 0; i < MAX_GRID_CELLS; i++) {
      const { lat, lon } = coordsForCell(i);
      const r = await worker.fetch(
        new Request('https://worker.test/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `198.51.100.${i + 1}` },
          body: JSON.stringify({ token: fakeToken(100 + i), lat, lon }),
        }),
        h3.env
      );
      expect(r.status).toBe(200);
    }
    const extraCell = coordsForCell(MAX_GRID_CELLS + 1);
    const resCap = await worker.fetch(
      new Request('https://worker.test/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.99' },
        body: JSON.stringify({ token: fakeToken(500), lat: extraCell.lat, lon: extraCell.lon }),
      }),
      h3.env
    );
    expect(resCap.status).toBe(503);
    expect(
      entries.some(
        (e) =>
          e.event === 'http.request' && e.status === 503 && e.code === 'coverage_at_capacity'
      )
    ).toBe(true);
    expect(
      entries.some(
        (e) => e.event === 'do.capacity_refused' && e.code === 'coverage_at_capacity'
      )
    ).toBe(true);

    // Fill cell 0 to MAX_DEVICES_PER_CELL + 1 to trigger cell_at_capacity
    const cell0 = coordsForCell(0);
    for (let d = 1; d < MAX_DEVICES_PER_CELL; d++) {
      const r = await worker.fetch(
        new Request('https://worker.test/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `192.0.2.${d + 1}` },
          body: JSON.stringify({ token: fakeToken(200 + d), lat: cell0.lat, lon: cell0.lon }),
        }),
        h3.env
      );
      expect(r.status).toBe(200);
    }
    const resCellCap = await worker.fetch(
      new Request('https://worker.test/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.250' },
        body: JSON.stringify({ token: fakeToken(999), lat: cell0.lat, lon: cell0.lon }),
      }),
      h3.env
    );
    expect(resCellCap.status).toBe(503);
    expect(
      entries.some(
        (e) => e.event === 'http.request' && e.status === 503 && e.code === 'cell_at_capacity'
      )
    ).toBe(true);
  });

  it('logs DO fail-open, dormant cell eviction, and RegistrationLimiter alarm events', async () => {
    const { entries } = captureLogs();

    // DO fail-open
    const failingDo = makeHarness({ failingDurableObjects: true });
    const res = await worker.fetch(
      new Request('https://worker.test/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.5' },
        body: JSON.stringify({ token: fakeToken(50), lat: 37.75, lon: -122.4 }),
      }),
      failingDo.env
    );
    expect(res.status).toBe(200);
    expect(
      entries.some(
        (e) => e.event === 'do.fail_open' && e.object === 'RegistrationLimiter' && e.op === 'check'
      )
    ).toBe(true);
    expect(
      entries.some(
        (e) => e.event === 'do.fail_open' && e.object === 'CoverageRegistry' && e.op === 'reserve'
      )
    ).toBe(true);

    // Dormant cell eviction
    vi.useFakeTimers();
    try {
      const t0 = Date.parse('2026-10-01T00:00:00.000Z');
      vi.setSystemTime(new Date(t0));
      const h = makeHarness();
      for (let i = 0; i < MAX_GRID_CELLS; i++) {
        const { lat, lon } = coordsForCell(i);
        await worker.fetch(
          new Request('https://worker.test/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `198.51.100.${i + 1}` },
            body: JSON.stringify({ token: fakeToken(300 + i), lat, lon }),
          }),
          h.env
        );
      }
      vi.setSystemTime(new Date(t0 + (DORMANT_CELL_THRESHOLD_SECONDS + 60) * 1000));
      const newcomer = coordsForCell(MAX_GRID_CELLS + 5);
      const admit = await worker.fetch(
        new Request('https://worker.test/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.200' },
          body: JSON.stringify({ token: fakeToken(777), lat: newcomer.lat, lon: newcomer.lon }),
        }),
        h.env
      );
      expect(admit.status).toBe(200);
      expect(
        entries.some(
          (e) => e.event === 'do.eviction' && e.object === 'CoverageRegistry' && e.reason === 'dormant_cells'
        )
      ).toBe(true);
      expect(entries.some((e) => e.event === 'register.evict_dormant')).toBe(true);

      // RegistrationLimiter alarm cleanup log
      const store = new Map<string, unknown>();
      let alarmAt: number | null = null;
      const mockState = {
        storage: {
          get: async <T>(k: string) => store.get(k) as T | undefined,
          put: async <T>(k: string, v: T) => {
            store.set(k, v);
          },
          deleteAll: async () => {
            store.clear();
          },
          getAlarm: async () => alarmAt,
          setAlarm: async (ts: number) => {
            alarmAt = ts;
          },
        },
      } as unknown as DurableObjectState;
      const limiter = new RegistrationLimiter(mockState);
      await limiter.fetch(
        new Request('https://limiter/check', {
          method: 'POST',
          body: JSON.stringify({ bucket: 'deadbeef01020304', windowSeconds: 60, maxRequests: 5 }),
        })
      );
      vi.setSystemTime(new Date(Date.now() + 120_000));
      await limiter.alarm();
      expect(
        entries.some(
          (e) =>
            e.event === 'do.alarm' &&
            e.object === 'RegistrationLimiter' &&
            e.prunedCount === 1 &&
            e.remainingCount === 0 &&
            e.deletedAll === true
        )
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Cron tick start, summary, and upstream error/timeout structured logging', () => {
  let signingKey: string;

  beforeAll(async () => {
    signingKey = await generateSigningKey();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('emits cron.start, upstream error/timeout events, APNs 410/activity events, and complete cron.summary without leaking tokens', async () => {
    const { entries, raw } = captureLogs();
    const harness = makeHarness({ signingKey });

    const c0 = coordsForCell(0); // WeatherKit 200 -> 2 devices (1 ok + 1 APNs 410)
    const c1 = coordsForCell(1); // WeatherKit 500
    const c2 = coordsForCell(2); // WeatherKit timeout

    const devOk = fakeToken(1);
    const devDead = fakeToken(2);
    const actOk = fakeToken(101);
    const actDead = fakeToken(102);
    const devErrCell = fakeToken(3);
    const devTimeoutCell = fakeToken(4);

    const baseRegistered = '2026-09-01T00:00:00.000Z';
    const seedDevice = async (token: string, lat: number, lon: number, registeredAt: string) => {
      await harness.kv.put(
        `device:${token}`,
        JSON.stringify({
          token,
          lat,
          lon,
          leadTimeMinutes: 20,
          registeredAt,
          renewedAt: new Date().toISOString(),
        }),
        { expirationTtl: 86400 }
      );
    };
    await seedDevice(devOk, c0.lat, c0.lon, '2026-09-01T00:00:00.000Z');
    await seedDevice(devDead, c0.lat, c0.lon, '2026-09-01T00:01:00.000Z');
    await seedDevice(devErrCell, c1.lat, c1.lon, '2026-09-01T00:02:00.000Z');
    await seedDevice(devTimeoutCell, c2.lat, c2.lon, '2026-09-01T00:03:00.000Z');
    await harness.kv.put(
      `activity:${devOk}`,
      JSON.stringify({ activityToken: actOk, activityUpdatedAt: baseRegistered }),
      { metadata: { activityToken: actOk }, expirationTtl: 86400 }
    );
    await harness.kv.put(
      `activity:${devDead}`,
      JSON.stringify({ activityToken: actDead, activityUpdatedAt: baseRegistered }),
      { metadata: { activityToken: actDead }, expirationTtl: 86400 }
    );

    const now = Date.now();
    const rainIncoming = {
      forecastNextHour: {
        minutes: Array.from({ length: 60 }, (_, m) => ({
          startTime: new Date(now + m * 60_000).toISOString(),
          precipitationChance: m >= 10 && m < 30 ? 0.9 : 0,
          precipitationIntensity: m >= 10 && m < 30 ? 3.5 : 0,
        })),
      },
      forecastHourly: {
        summary: [{ condition: 'rain' }],
      },
    };

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://weatherkit.apple.com/')) {
        if (url.includes(`/${c0.lat}/${c0.lon}`)) {
          return new Response(JSON.stringify(rainIncoming), { status: 200 });
        }
        if (url.includes(`/${c1.lat}/${c1.lon}`)) {
          return new Response('Upstream error', { status: 500 });
        }
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }
      if (url.includes(`/3/device/${devDead}`)) {
        return new Response(JSON.stringify({ reason: 'Unregistered' }), { status: 410 });
      }
      if (url.includes(`/3/device/${actDead}`)) {
        return new Response(JSON.stringify({ reason: 'Unregistered' }), { status: 410 });
      }
      return new Response('', { status: 200 });
    });

    await worker.scheduled(
      { scheduledTime: now } as ScheduledEvent,
      harness.env,
      {} as ExecutionContext
    );

    expect(entries.some((e) => e.event === 'cron.start')).toBe(true);
    expect(
      entries.some((e) => e.event === 'weatherkit.error' && e.status === 500 && typeof e.durationMs === 'number')
    ).toBe(true);
    expect(
      entries.some((e) => e.event === 'weatherkit.timeout' && typeof e.durationMs === 'number')
    ).toBe(true);
    expect(
      entries.some((e) => e.event === 'apns.error' && e.pushType === 'alert' && e.status === 410)
    ).toBe(true);
    expect(
      entries.some((e) => e.event === 'apns.token_reaped' && e.reason === 'unregistered')
    ).toBe(true);
    expect(
      entries.some((e) => e.event === 'activity.token_cleared' && e.reason === 'Unregistered')
    ).toBe(true);

    const summary = entries.find((e) => e.event === 'cron.summary');
    expect(summary).toBeDefined();
    expect(summary).toMatchObject({
      event: 'cron.summary',
      level: 'info',
      cellsProcessed: 3,
      evictedCells: 0,
      weatherkitOk: 1,
      weatherkitErr: 2,
      weatherkitTimeout: 1,
      apnsSent: 1,
      apnsFailed: 1,
      apns410Reaped: 1,
      activitySent: 1,
      activityFailed: 1,
      pushBudgetDropped: 0,
    });
    expect(typeof summary?.durationMs).toBe('number');

    const joined = raw.join('\n');
    for (const secret of [devOk, devDead, actOk, actDead, devErrCell, devTimeoutCell]) {
      expect(joined).not.toContain(secret);
    }
  });
});
