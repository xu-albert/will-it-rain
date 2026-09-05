// Tests for WHAT the cron pushes into a Live Activity, and for the admin
// endpoints that drive that path on demand.
//
// cron-alerts.test.ts pins who gets an ordinary alert and when. This file pins
// the content-state that rides the `liveactivity` push, because that payload is
// a full replacement, not a merge: whatever the Worker sends is what the card
// draws from the next tick on. The field that matters most is `precip` — the
// rain-vs-wintry styling the widget reads — and the contract is that every
// production push carries it. A push without it decodes as nil on the phone
// and quietly turns a snowing card cyan.

import { describe, expect, it, beforeAll, beforeEach, vi } from 'vitest';
import worker, { precipFromForecast } from '../src/index';
import { DEVICE_RECORD_TTL_SECONDS } from '../src/abuse';
import { Harness, coordsForCell, fakeToken, generateSigningKey, makeHarness } from './harness';

let signingKey = '';

beforeAll(async () => {
  signingKey = await generateSigningKey();
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

interface Minute {
  startTime: string;
  precipitationChance: number;
  precipitationIntensity: number;
}

interface SummaryPeriod {
  startTime?: string;
  condition?: string;
}

/**
 * A 60-minute `forecastNextHour`, one entry per minute, plus the `summary`
 * rollup the precipitation type comes from. `summary: undefined` leaves the
 * field out entirely, as a pre-2026 response shape (or a schema change) would.
 */
function forecast(
  now: number,
  wet: (i: number) => boolean,
  options: { firstMinuteOffsetMinutes?: number; summary?: SummaryPeriod[] } = {}
): { forecastNextHour: { minutes: Minute[]; summary?: SummaryPeriod[] } } {
  const offset = (options.firstMinuteOffsetMinutes ?? 0) * 60_000;
  return {
    forecastNextHour: {
      minutes: Array.from({ length: 60 }, (_, i) => ({
        startTime: new Date(now + offset + i * 60_000).toISOString(),
        precipitationChance: wet(i) ? 0.9 : 0,
        precipitationIntensity: wet(i) ? 2 : 0,
      })),
      ...(options.summary === undefined ? {} : { summary: options.summary }),
    },
  };
}

const activityTokenFor = (n: number) => `ac${n.toString(16).padStart(2, '0')}`.repeat(41);

/** Plants one device with a running Live Activity, straight into KV. */
async function plantWithActivity(
  harness: Harness,
  n: number,
  now: number,
  options: { leadTimeMinutes?: number; withActivity?: boolean } = {}
): Promise<void> {
  const { lat, lon } = coordsForCell(0);
  await harness.kv.put(
    `device:${fakeToken(n)}`,
    JSON.stringify({
      token: fakeToken(n),
      lat,
      lon,
      leadTimeMinutes: options.leadTimeMinutes ?? 30,
      registeredAt: new Date(now - n * 1000).toISOString(),
      renewedAt: new Date(now).toISOString(),
    }),
    { expirationTtl: DEVICE_RECORD_TTL_SECONDS }
  );
  if (options.withActivity === false) return;
  const activityToken = activityTokenFor(n);
  await harness.kv.put(
    `activity:${fakeToken(n)}`,
    JSON.stringify({ activityToken, activityUpdatedAt: new Date(now).toISOString() }),
    { expirationTtl: DEVICE_RECORD_TTL_SECONDS, metadata: { activityToken } }
  );
}

interface ActivityPush {
  activityToken: string;
  event: string;
  contentState: Record<string, unknown>;
  aps: Record<string, unknown>;
}

interface Captured {
  activityPushes: ActivityPush[];
  alertPushes: number;
}

/** Stubs WeatherKit and APNs for one call, recording every Live Activity push. */
async function capturing<T>(
  forecastFor: (now: number) => unknown,
  run: () => Promise<T>
): Promise<{ result: T; captured: Captured }> {
  const now = Date.now();
  const captured: Captured = { activityPushes: [], alertPushes: 0 };

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('weatherkit.apple.com')) {
      return new Response(JSON.stringify(forecastFor(now)), { status: 200 });
    }
    if (url.includes('push.apple.com')) {
      const headers = new Headers(init?.headers);
      const payload = JSON.parse(String(init?.body)) as { aps: Record<string, unknown> };
      if (headers.get('apns-push-type') === 'liveactivity') {
        captured.activityPushes.push({
          activityToken: url.slice(url.lastIndexOf('/') + 1),
          event: String(payload.aps.event),
          contentState: payload.aps['content-state'] as Record<string, unknown>,
          aps: payload.aps,
        });
      } else {
        captured.alertPushes += 1;
      }
      return new Response('', { status: 200 });
    }
    throw new Error(`Unexpected outbound request to ${url}`);
  });

  try {
    return { result: await run(), captured };
  } finally {
    vi.unstubAllGlobals();
  }
}

async function tick(harness: Harness, forecastFor: (now: number) => unknown): Promise<Captured> {
  const { captured } = await capturing(forecastFor, () =>
    worker.scheduled({} as ScheduledEvent, harness.env, {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext)
  );
  return captured;
}

const rainAt = (from: number, summary?: SummaryPeriod[]) => (t: number) =>
  forecast(t, (i) => i >= from, { summary });
const rainingUntil = (until: number, summary?: SummaryPeriod[]) => (t: number) =>
  forecast(t, (i) => i < until, { summary });

describe('precipFromForecast', () => {
  const withSummary = (summary?: SummaryPeriod[]) => ({
    forecastNextHour: { minutes: [], ...(summary === undefined ? {} : { summary }) },
  });

  it('defaults to rain when the summary is missing, empty, or all clear', () => {
    expect(precipFromForecast({})).toBe('rain');
    expect(precipFromForecast(withSummary(undefined))).toBe('rain');
    expect(precipFromForecast(withSummary([]))).toBe('rain');
    expect(precipFromForecast(withSummary([{ condition: 'clear' }]))).toBe('rain');
    expect(precipFromForecast(withSummary([{}]))).toBe('rain');
  });

  it('reads the first non-clear period, so snow after a clear spell is still snow', () => {
    expect(precipFromForecast(withSummary([{ condition: 'clear' }, { condition: 'snow' }]))).toBe('wintry');
    expect(precipFromForecast(withSummary([{ condition: 'rain' }, { condition: 'snow' }]))).toBe('rain');
  });

  it('groups everything with ice in it as wintry, whatever the casing or spacing', () => {
    for (const c of ['snow', 'sleet', 'hail', 'mixed', 'flurries', 'Snow', 'wintry mix', 'wintry_mix', 'Wintry-Mix']) {
      expect(precipFromForecast(withSummary([{ condition: c }])), c).toBe('wintry');
    }
    for (const c of ['rain', 'Rain', 'drizzle', 'heavyRain']) {
      expect(precipFromForecast(withSummary([{ condition: c }])), c).toBe('rain');
    }
  });
});

describe('the cron pushes precip on every Live Activity update', () => {
  it('sends rain copy and precip=rain when the summary says rain', async () => {
    const harness = makeHarness({ signingKey });
    await plantWithActivity(harness, 1, Date.now());

    const { activityPushes } = await tick(harness, rainAt(20, [{ condition: 'rain' }]));

    expect(activityPushes).toHaveLength(1);
    expect(activityPushes[0].activityToken).toBe(activityTokenFor(1));
    expect(activityPushes[0].event).toBe('update');
    expect(activityPushes[0].contentState).toMatchObject({
      statusText: 'Rain incoming',
      subBold: 'Rain expected',
      precip: 'rain',
    });
  });

  it('sends snow copy and precip=wintry when the summary says snow', async () => {
    const harness = makeHarness({ signingKey });
    await plantWithActivity(harness, 1, Date.now());

    const { activityPushes } = await tick(
      harness,
      rainAt(20, [{ condition: 'clear' }, { condition: 'snow' }])
    );

    expect(activityPushes).toHaveLength(1);
    expect(activityPushes[0].contentState).toMatchObject({
      statusText: 'Snow incoming',
      subBold: 'Snow expected',
      precip: 'wintry',
    });
  });

  it('still sends precip=rain when the summary field is absent altogether', async () => {
    // The old behaviour, and the right default for a rain app: a schema change
    // upstream must degrade to rain, never to a payload with no precip.
    const harness = makeHarness({ signingKey });
    await plantWithActivity(harness, 1, Date.now());

    const { activityPushes } = await tick(harness, rainAt(20));

    expect(activityPushes).toHaveLength(1);
    expect(activityPushes[0].contentState.precip).toBe('rain');
  });

  it('keeps the wintry treatment on the falling-now update', async () => {
    const harness = makeHarness({ signingKey });
    await plantWithActivity(harness, 1, Date.now());

    const { activityPushes } = await tick(harness, rainingUntil(40, [{ condition: 'sleet' }]));

    expect(activityPushes).toHaveLength(1);
    expect(activityPushes[0].event).toBe('update');
    expect(activityPushes[0].contentState).toMatchObject({
      statusText: 'Snowing now',
      subRest: 'Snowing · ',
      precip: 'wintry',
    });
  });

  it('keeps the wintry treatment on the terminal end push and drops the token', async () => {
    const harness = makeHarness({ signingKey });
    await plantWithActivity(harness, 1, Date.now());

    // Wet at minute 0 (one minute ago), dry from minute 1 (= now): the rain has
    // just ended, so the cron sends the final state and ends the activity.
    const { activityPushes } = await tick(harness, (t) =>
      forecast(t, (i) => i < 1, { firstMinuteOffsetMinutes: -1, summary: [{ condition: 'snow' }] })
    );

    expect(activityPushes).toHaveLength(1);
    expect(activityPushes[0].event).toBe('end');
    expect(activityPushes[0].contentState).toMatchObject({
      statusText: 'Snow ended',
      subBold: 'Snow has stopped',
      precip: 'wintry',
    });
    expect(harness.kv.raw(`activity:${fakeToken(1)}`)).toBeUndefined();
  });

  it('never sends a Live Activity payload without precip', async () => {
    const harness = makeHarness({ signingKey });
    const now = Date.now();
    await plantWithActivity(harness, 1, now);
    await plantWithActivity(harness, 2, now);

    const shapes = [
      rainAt(20),
      rainAt(20, [{ condition: 'snow' }]),
      rainingUntil(40),
      rainingUntil(40, [{ condition: 'mixed' }]),
    ];
    for (const shape of shapes) {
      // Fresh dedup state per shape so every push actually goes out.
      for (const n of [1, 2]) {
        await harness.kv.delete(`notified-start:${fakeToken(n)}`);
        await harness.kv.delete(`notified-end:${fakeToken(n)}`);
      }
      const { activityPushes } = await tick(harness, shape);
      expect(activityPushes.length).toBeGreaterThan(0);
      for (const push of activityPushes) {
        expect(push.contentState).toHaveProperty('precip');
        expect(['rain', 'wintry']).toContain(push.contentState.precip);
      }
    }
  });
});

// The admin endpoints. Sending one real push at one real device is the whole
// point of these, so they must stay behind ADMIN_TOKEN: the Worker URL ships
// in the app binary.
const ADMIN = 'local-test-secret';

function adminRequest(path: string, body: unknown, options: { token?: string | null } = {}): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.token !== null) headers['X-Admin-Token'] = options.token ?? ADMIN;
  return new Request(`https://worker.test${path}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('/test-activity', () => {
  it('and the other test endpoints refuse a missing or wrong admin token', async () => {
    const harness = makeHarness({ signingKey });
    harness.env.ADMIN_TOKEN = ADMIN;
    const body = { token: fakeToken(1), lat: 37.3, lon: -122.0 };

    for (const path of ['/test-activity', '/test-rain', '/test-cron']) {
      const missing = await worker.fetch(adminRequest(path, body, { token: null }), harness.env);
      expect(missing.status, `${path} without a token`).toBe(401);
      const wrong = await worker.fetch(adminRequest(path, body, { token: 'wrong' }), harness.env);
      expect(wrong.status, `${path} with the wrong token`).toBe(401);
    }
  });

  it('fails closed when no ADMIN_TOKEN is configured at all', async () => {
    const harness = makeHarness({ signingKey });
    const res = await worker.fetch(adminRequest('/test-activity', { token: fakeToken(1) }), harness.env);
    expect(res.status).toBe(401);
  });

  it('tells a missing device apart from a device with no running activity', async () => {
    const harness = makeHarness({ signingKey });
    harness.env.ADMIN_TOKEN = ADMIN;
    await plantWithActivity(harness, 1, Date.now(), { withActivity: false });

    const noDevice = await worker.fetch(adminRequest('/test-activity', { token: fakeToken(2) }), harness.env);
    expect(noDevice.status).toBe(404);

    const noActivity = await worker.fetch(adminRequest('/test-activity', { token: fakeToken(1) }), harness.env);
    expect(noActivity.status).toBe(409);

    const badToken = await worker.fetch(adminRequest('/test-activity', { token: 'nope' }), harness.env);
    expect(badToken.status).toBe(400);

    const malformed = await worker.fetch(adminRequest('/test-activity', '{not json'), harness.env);
    expect(malformed.status).toBe(400);
  });

  it('pushes the requested precip at the stored activity token', async () => {
    const harness = makeHarness({ signingKey });
    harness.env.ADMIN_TOKEN = ADMIN;
    await plantWithActivity(harness, 1, Date.now());

    const { result, captured } = await capturing(rainAt(20), () =>
      worker.fetch(
        adminRequest('/test-activity', { token: fakeToken(1), precip: 'wintry', minutesUntil: 30 }),
        harness.env
      )
    );

    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ ok: true, event: 'update', precip: 'wintry', minutesUntil: 30 });
    expect(captured.activityPushes).toHaveLength(1);
    expect(captured.activityPushes[0].activityToken).toBe(activityTokenFor(1));
    expect(captured.activityPushes[0].contentState).toMatchObject({
      statusText: 'Snow incoming',
      precip: 'wintry',
    });
    expect(captured.alertPushes).toBe(0);
  });

  it('omits precip entirely when the body carries none, to stand in for an old Worker', async () => {
    // Absence, not null: the legacy payload has no key at all, and that is the
    // shape the widget's Optional decode has to survive.
    const harness = makeHarness({ signingKey });
    harness.env.ADMIN_TOKEN = ADMIN;
    await plantWithActivity(harness, 1, Date.now());

    const { result, captured } = await capturing(rainAt(20), () =>
      worker.fetch(adminRequest('/test-activity', { token: fakeToken(1), minutesUntil: 11 }), harness.env)
    );

    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ precip: null });
    expect(captured.activityPushes).toHaveLength(1);
    expect(captured.activityPushes[0].contentState).not.toHaveProperty('precip');
    expect(captured.activityPushes[0].contentState.statusText).toBe('Rain incoming');
  });

  it('can end the activity', async () => {
    const harness = makeHarness({ signingKey });
    harness.env.ADMIN_TOKEN = ADMIN;
    await plantWithActivity(harness, 1, Date.now());

    const { result, captured } = await capturing(rainAt(20), () =>
      worker.fetch(adminRequest('/test-activity', { token: fakeToken(1), event: 'end' }), harness.env)
    );

    expect(result.status).toBe(200);
    expect(captured.activityPushes[0].event).toBe('end');
    expect(captured.activityPushes[0].aps).toHaveProperty('dismissal-date');
  });
});

describe('/test-cron dryRun', () => {
  const body = { token: fakeToken(1), lat: 41.8781, lon: -87.6298 };

  it('reports what the summary said without pushing anything', async () => {
    const harness = makeHarness({ signingKey });
    harness.env.ADMIN_TOKEN = ADMIN;

    const { result, captured } = await capturing(
      rainAt(20, [{ condition: 'clear' }, { condition: 'snow' }]),
      () => worker.fetch(adminRequest('/test-cron', { ...body, dryRun: true }), harness.env)
    );

    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      ok: true,
      result: 'rain_detected',
      precip: 'wintry',
      summary: ['clear', 'snow'],
      dryRun: true,
    });
    expect(captured.alertPushes).toBe(0);
    expect(captured.activityPushes).toHaveLength(0);
  });

  it('reports a null summary when WeatherKit sends none, and still does not throw', async () => {
    const harness = makeHarness({ signingKey });
    harness.env.ADMIN_TOKEN = ADMIN;

    const { result } = await capturing(
      () => ({}),
      () => worker.fetch(adminRequest('/test-cron', { ...body, dryRun: true }), harness.env)
    );

    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ result: 'no_forecast_data', precip: 'rain', summary: null });
  });

  it('pushes the alert when not a dry run', async () => {
    const harness = makeHarness({ signingKey });
    harness.env.ADMIN_TOKEN = ADMIN;

    const { result, captured } = await capturing(rainAt(20), () =>
      worker.fetch(adminRequest('/test-cron', body), harness.env)
    );

    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ result: 'rain_detected', dryRun: false });
    expect(captured.alertPushes).toBe(1);
  });
});
