// Tests for WHO the cron alerts and WHEN.
//
// abuse.test.ts drives scheduled() to count what a tick spends; nothing there
// asserts that the right device is alerted at the right minute. That gate is the
// product: an alert later than the lead time the user asked for (up to one
// server check period early is the accepted safe direction), a duplicate, or a
// missing one is (per VISION.md) a bug of the highest class. These pin the
// contract through the real scheduled() handler with a stubbed WeatherKit and a
// stubbed APNs, so the arithmetic inside the tick is what is under test.

import { describe, expect, it, beforeAll, beforeEach, vi } from 'vitest';
import worker from '../src/index';
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

/**
 * A 60-minute WeatherKit `forecastNextHour`, one entry per minute. `wet(i)`
 * decides minute i; `firstMinuteOffset` shifts the whole series, because the
 * real feed's first timestamp is often a few minutes in the past by the time
 * the tick reads it.
 */
function forecast(
  now: number,
  wet: (i: number) => boolean,
  options: { firstMinuteOffsetMinutes?: number; chance?: number; intensity?: number } = {}
): { forecastNextHour: { minutes: Minute[] } } {
  const offset = (options.firstMinuteOffsetMinutes ?? 0) * 60_000;
  return {
    forecastNextHour: {
      minutes: Array.from({ length: 60 }, (_, i) => ({
        startTime: new Date(now + offset + i * 60_000).toISOString(),
        precipitationChance: wet(i) ? (options.chance ?? 0.9) : 0,
        precipitationIntensity: wet(i) ? (options.intensity ?? 2) : 0,
      })),
    },
  };
}

interface Planted {
  n: number;
  leadTimeMinutes?: number;
  rainStartEnabled?: boolean;
  rainEndEnabled?: boolean;
}

/** Puts every device straight into KV, all in the same grid cell. */
async function plant(harness: Harness, devices: Planted[], now: number): Promise<void> {
  const { lat, lon } = coordsForCell(0);
  for (const d of devices) {
    await harness.kv.put(
      `device:${fakeToken(d.n)}`,
      JSON.stringify({
        token: fakeToken(d.n),
        lat,
        lon,
        leadTimeMinutes: d.leadTimeMinutes ?? 20,
        rainStartEnabled: d.rainStartEnabled,
        rainEndEnabled: d.rainEndEnabled,
        registeredAt: new Date(now - d.n * 1000).toISOString(),
        renewedAt: new Date(now).toISOString(),
      }),
      { expirationTtl: DEVICE_RECORD_TTL_SECONDS }
    );
  }
}

/** Plants a Live Activity push token for device `n`, as /register-activity would. */
async function plantActivity(harness: Harness, n: number, activityN: number, now: number): Promise<void> {
  await harness.kv.put(
    `activity:${fakeToken(n)}`,
    JSON.stringify({ activityToken: fakeToken(activityN), activityUpdatedAt: new Date(now).toISOString() }),
    { expirationTtl: DEVICE_RECORD_TTL_SECONDS, metadata: { activityToken: fakeToken(activityN) } }
  );
}

interface AlertPush {
  token: string;
  title: string;
}

interface ActivityPush {
  token: string;
  event: string;
  statusText: string;
  subBold: string;
}

/** Runs one real cron tick and returns every alert and Live Activity update it sent. */
async function tick(
  harness: Harness,
  forecastFor: (now: number) => unknown
): Promise<{ alerts: AlertPush[]; activities: ActivityPush[]; now: number }> {
  const now = Date.now();
  const alerts: AlertPush[] = [];
  const activities: ActivityPush[] = [];

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('weatherkit.apple.com')) {
      return new Response(JSON.stringify(forecastFor(now)), { status: 200 });
    }
    if (url.includes('push.apple.com')) {
      const headers = new Headers(init?.headers);
      const token = url.slice(url.lastIndexOf('/') + 1);
      if (headers.get('apns-push-type') === 'alert') {
        const payload = JSON.parse(String(init?.body)) as { aps: { alert: { title: string } } };
        alerts.push({ token, title: payload.aps.alert.title });
      }
      if (headers.get('apns-push-type') === 'liveactivity') {
        const payload = JSON.parse(String(init?.body)) as {
          aps: { event: string; 'content-state': { statusText: string; subBold: string } };
        };
        const state = payload.aps['content-state'];
        activities.push({ token, event: payload.aps.event, statusText: state.statusText, subBold: state.subBold });
      }
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

  return { alerts, activities, now };
}

function alerted(alerts: AlertPush[]): string[] {
  return alerts.map((a) => a.token).sort();
}

describe('rain-start alerts', () => {
  it('reach a device only once the rain is inside its own lead time', async () => {
    const harness = makeHarness({ signingKey });
    const now = Date.now();
    await plant(
      harness,
      [
        { n: 1, leadTimeMinutes: 10 },
        { n: 2, leadTimeMinutes: 30 },
        { n: 3, leadTimeMinutes: 25 }, // exactly at the boundary: inclusive
      ],
      now
    );

    // Dry for 25 minutes, then rain for the rest of the hour.
    const { alerts } = await tick(harness, (t) => forecast(t, (i) => i >= 25));

    expect(alerted(alerts)).toEqual([fakeToken(2), fakeToken(3)].sort());
    expect(alerts.every((a) => a.title === 'Rain in ~25 min')).toBe(true);
  });

  it('widens the window by one cron period so the shortest lead time can fire on its first tick', async () => {
    // A 10-minute lead time equals the cron period: rain 10.6 minutes out (here,
    // the first wet minute at i=11) used to land outside `<= leadTimeMinutes`
    // and only alert on the following tick, with under a minute of lead left.
    const harness = makeHarness({ signingKey });
    const now = Date.now();
    await plant(harness, [{ n: 1, leadTimeMinutes: 10 }], now);

    const { alerts } = await tick(harness, (t) => forecast(t, (i) => i >= 11));

    expect(alerted(alerts)).toEqual([fakeToken(1)]);
  });

  it('still holds a ceiling: nothing fires further out than lead time plus one cron period', async () => {
    const harness = makeHarness({ signingKey });
    const now = Date.now();
    await plant(harness, [{ n: 1, leadTimeMinutes: 10 }], now);

    const { alerts } = await tick(harness, (t) => forecast(t, (i) => i >= 21));

    expect(alerts).toEqual([]);
  });

  it('still fire when the feed says the rain began a few minutes ago', async () => {
    // WeatherKit's minute series is often stamped a few minutes before the tick
    // reads it. A first wet minute slightly in the past is "starting now", not
    // a missed event — but one more than five minutes back is stale and skipped.
    const harness = makeHarness({ signingKey });
    const now = Date.now();
    await plant(harness, [{ n: 1, leadTimeMinutes: 20 }], now);

    // Series starts 8 minutes ago; dry until minute 5 (= 3 minutes ago).
    const recent = await tick(harness, (t) =>
      forecast(t, (i) => i >= 5, { firstMinuteOffsetMinutes: -8 })
    );
    expect(alerted(recent.alerts)).toEqual([fakeToken(1)]);
    expect(recent.alerts[0].title).toBe('Rain starting now');

    // Same shape, but the first wet minute is 6 minutes back: too old.
    const stale = makeHarness({ signingKey });
    await plant(stale, [{ n: 1, leadTimeMinutes: 20 }], now);
    const late = await tick(stale, (t) =>
      forecast(t, (i) => i >= 2, { firstMinuteOffsetMinutes: -8 })
    );
    expect(late.alerts).toEqual([]);
  });

  it('reach devices where WeatherKit has no minute forecast, from the hourly one', async () => {
    // Outside forecastNextHour coverage the tick used to return before any
    // alert. Hourly readings: the current hour dry, the next wet — so rain
    // begins at the top of the next hour. The clock is pinned so that the
    // minutes to that hour are a chosen number, not whatever the wall clock
    // happens to read.
    const hourly = (t: number) => {
      const hour0 = t - (t % 3_600_000);
      return {
        forecastHourly: {
          hours: [0, 1, 2].map((h) => ({
            forecastStart: new Date(hour0 + h * 3_600_000).toISOString(),
            precipitationChance: h === 1 ? 0.9 : 0,
            precipitationIntensity: h === 1 ? 2 : 0,
          })),
        },
      };
    };
    const devices = [
      { n: 1, leadTimeMinutes: 60 },
      { n: 2, leadTimeMinutes: 20 },
    ];

    vi.useFakeTimers();
    try {
      // Five past: 55 minutes to the rain, inside the 60-minute lead time only.
      vi.setSystemTime(new Date('2026-01-01T10:05:00.000Z'));
      const early = makeHarness({ signingKey });
      await plant(early, devices, Date.now());
      const atFivePast = await tick(early, hourly);
      expect(alerted(atFivePast.alerts)).toEqual([fakeToken(1)]);
      expect(atFivePast.alerts[0].title).toBe('Rain in ~55 min');

      // Quarter to: 15 minutes, inside both.
      vi.setSystemTime(new Date('2026-01-01T10:45:00.000Z'));
      const late = makeHarness({ signingKey });
      await plant(late, devices, Date.now());
      const atQuarterTo = await tick(late, hourly);
      expect(alerted(atQuarterTo.alerts)).toEqual([fakeToken(1), fakeToken(2)].sort());
      expect(atQuarterTo.alerts.every((a) => a.title === 'Rain in ~15 min')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('are not repeated for the same event within 30 minutes', async () => {
    // 30 minutes is the floor, and the whole window for a lead time of 15 or
    // less: lead time, one cron period and the post-onset slack fit inside it.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
      const harness = makeHarness({ signingKey });
      await plant(harness, [{ n: 1, leadTimeMinutes: 15 }], Date.now());
      const rainSoon = (t: number) => forecast(t, (i) => i >= 10);

      const first = await tick(harness, rainSoon);
      expect(alerted(first.alerts)).toEqual([fakeToken(1)]);

      const second = await tick(harness, rainSoon);
      expect(second.alerts).toEqual([]);

      // A tick landing exactly on the window's edge is still the same event.
      await harness.kv.put(`notified-start:${fakeToken(1)}`, String(Date.now() - 30 * 60_000), {
        expirationTtl: 3600,
      });
      const atEdge = await tick(harness, rainSoon);
      expect(atEdge.alerts).toEqual([]);

      // Strictly past it, the next tick may alert again.
      await harness.kv.put(`notified-start:${fakeToken(1)}`, String(Date.now() - 31 * 60_000), {
        expirationTtl: 3600,
      });
      const third = await tick(harness, rainSoon);
      expect(alerted(third.alerts)).toEqual([fakeToken(1)]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('are not repeated by the tick that watches one onset arrive', async () => {
    // Hourly-fallback path, where onsets sit on clock hours and the synthesized
    // series starts one cron period behind `now` — so at 13:00 the first minute
    // read is 12:50, still dry, and the 13:00 onset is still a rain START. The
    // default lead time alerts at 12:30 and every later tick in the span is the
    // same event, including the one that lands as the rain begins.
    const hourly = (wetHour: number) => () => ({
      forecastHourly: {
        hours: [11, 12, 13, 14].map((h) => ({
          forecastStart: new Date(Date.parse(`2026-01-01T${h}:00:00.000Z`)).toISOString(),
          precipitationChance: h === wetHour ? 0.9 : 0,
          precipitationIntensity: h === wetHour ? 2 : 0,
        })),
      },
    });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T12:30:00.000Z'));
      const harness = makeHarness({ signingKey });
      await plant(harness, [{ n: 1, leadTimeMinutes: 20 }], Date.now());

      const first = await tick(harness, hourly(13));
      expect(alerted(first.alerts)).toEqual([fakeToken(1)]);
      expect(first.alerts[0].title).toBe('Rain in ~30 min');

      for (const at of ['12:40', '12:50', '13:00']) {
        vi.setSystemTime(new Date(`2026-01-01T${at}:00.000Z`));
        const later = await tick(harness, hourly(13));
        expect(later.alerts).toEqual([]);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('are not repeated by a later tick still inside the widened window', async () => {
    // The dedup window has to be at least as wide as the window that alerts:
    // at a 30-minute lead time the tick 30 minutes after the first alert still
    // sees the same onset (5 minutes out, so not yet raining) and used to
    // announce it a second time.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
      const harness = makeHarness({ signingKey });
      await plant(harness, [{ n: 1, leadTimeMinutes: 30 }], Date.now());

      // One fixed onset, 35 minutes out at noon, seen afresh by every tick.
      const onset = Date.parse('2026-01-01T12:35:00.000Z');
      const sameRain = (t: number) => forecast(t, (i) => t + i * 60_000 >= onset);

      const noon = await tick(harness, sameRain);
      expect(alerted(noon.alerts)).toEqual([fakeToken(1)]);
      expect(noon.alerts[0].title).toBe('Rain in ~35 min');

      for (const minute of [10, 20, 30]) {
        vi.setSystemTime(new Date(Date.parse('2026-01-01T12:00:00.000Z') + minute * 60_000));
        const later = await tick(harness, sameRain);
        expect(later.alerts).toEqual([]);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('respect a device that turned rain-start alerts off', async () => {
    const harness = makeHarness({ signingKey });
    const now = Date.now();
    await plant(
      harness,
      [
        { n: 1, leadTimeMinutes: 30, rainStartEnabled: false },
        { n: 2, leadTimeMinutes: 30 }, // undefined means enabled
      ],
      now
    );

    const { alerts } = await tick(harness, (t) => forecast(t, (i) => i >= 10));
    expect(alerted(alerts)).toEqual([fakeToken(2)]);
  });

  it('are not sent while it is already raining', async () => {
    // Rain that is already falling is the rain-END path's business; a start
    // alert for it would be an interruption the user did not ask for.
    const harness = makeHarness({ signingKey });
    const now = Date.now();
    await plant(harness, [{ n: 1, leadTimeMinutes: 60, rainEndEnabled: false }], now);

    const { alerts } = await tick(harness, (t) => forecast(t, () => true));
    expect(alerts).toEqual([]);
  });
});

describe('rain-end alerts', () => {
  it('go out only inside the last 30 minutes of the rain', async () => {
    const now = Date.now();

    const farOff = makeHarness({ signingKey });
    await plant(farOff, [{ n: 1 }], now);
    const early = await tick(farOff, (t) => forecast(t, (i) => i < 45));
    expect(early.alerts).toEqual([]);

    const soon = makeHarness({ signingKey });
    await plant(soon, [{ n: 1 }], now);
    const late = await tick(soon, (t) => forecast(t, (i) => i < 20));
    expect(alerted(late.alerts)).toEqual([fakeToken(1)]);
    expect(late.alerts[0].title).toBe('Rain ending soon');
  });

  it('respect a device that turned rain-end alerts off', async () => {
    const harness = makeHarness({ signingKey });
    const now = Date.now();
    await plant(
      harness,
      [
        { n: 1, rainEndEnabled: false },
        { n: 2 },
      ],
      now
    );

    const { alerts } = await tick(harness, (t) => forecast(t, (i) => i < 20));
    expect(alerted(alerts)).toEqual([fakeToken(2)]);
  });

  it('are not sent when the rain outlasts the forecast hour', async () => {
    const harness = makeHarness({ signingKey });
    const now = Date.now();
    await plant(harness, [{ n: 1 }], now);

    const { alerts } = await tick(harness, (t) => forecast(t, () => true));
    expect(alerts).toEqual([]);
  });
});

describe('Live Activity updates where WeatherKit has no minute forecast', () => {
  it('end the activity at the tick after a wet hour ends', async () => {
    // Hour 10 wet, hour 11 dry, one device with a Live Activity. The terminal
    // "Rain ended" update goes out at the tick that first sees a dry minute at
    // or before now behind a wet one. With the real feed that is the 11:00
    // tick, because the feed's first minute lags it; the synthesized series
    // begins one cron interval back for the same reason, so that tick still
    // opens on the last wet minutes of hour 10 instead of on a dry hour 11 it
    // would have returned from before any Live Activity work.
    const hour = (h: number) => Date.UTC(2026, 0, 1, h, 0, 0);
    const hourly = () => ({
      forecastHourly: {
        hours: [9, 10, 11, 12].map((h) => ({
          forecastStart: new Date(hour(h)).toISOString(),
          precipitationChance: h === 10 ? 0.9 : 0,
          precipitationIntensity: h === 10 ? 2 : 0,
        })),
      },
    });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(hour(10) + 50 * 60_000));
      const harness = makeHarness({ signingKey });
      await plant(harness, [{ n: 1 }], Date.now());
      await plantActivity(harness, 1, 2, Date.now());

      // Ten to eleven: still raining, ten minutes left on the countdown.
      const tenTo = await tick(harness, hourly);
      expect(tenTo.activities).toEqual([
        { token: fakeToken(2), event: 'update', statusText: 'Raining now', subBold: 'stops in about 10 min' },
      ]);
      expect(alerted(tenTo.alerts)).toEqual([fakeToken(1)]);
      expect(tenTo.alerts[0].title).toBe('Rain ending soon');

      // On the hour: the dry minute has arrived, so the activity is ended and
      // its token dropped; the rain-end alert was already sent ten minutes ago.
      vi.setSystemTime(new Date(hour(11)));
      const onTheHour = await tick(harness, hourly);
      expect(onTheHour.activities).toEqual([
        { token: fakeToken(2), event: 'end', statusText: 'Rain ended', subBold: 'Rain has stopped' },
      ]);
      expect(harness.kv.raw(`activity:${fakeToken(1)}`)).toBeUndefined();
      expect(onTheHour.alerts).toEqual([]);

      // Ten past: a dry hour all round, nothing more to say.
      vi.setSystemTime(new Date(hour(11) + 10 * 60_000));
      const tenPast = await tick(harness, hourly);
      expect(tenPast.activities).toEqual([]);
      expect(tenPast.alerts).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('what counts as a wet minute', () => {
  // The cron's own threshold, not WeatherKit's: chance strictly above 30% AND
  // some predicted intensity. Either half alone is not rain.
  const rainAt10 = (options: { chance: number; intensity: number }) => (t: number) =>
    forecast(t, (i) => i >= 10, options);

  it('needs the chance to be above 30%, not at it', async () => {
    const harness = makeHarness({ signingKey });
    await plant(harness, [{ n: 1, leadTimeMinutes: 30 }], Date.now());
    const at = await tick(harness, rainAt10({ chance: 0.3, intensity: 2 }));
    expect(at.alerts).toEqual([]);

    const above = makeHarness({ signingKey });
    await plant(above, [{ n: 1, leadTimeMinutes: 30 }], Date.now());
    const over = await tick(above, rainAt10({ chance: 0.31, intensity: 2 }));
    expect(alerted(over.alerts)).toEqual([fakeToken(1)]);
  });

  it('needs some predicted intensity, however likely the rain', async () => {
    const harness = makeHarness({ signingKey });
    await plant(harness, [{ n: 1, leadTimeMinutes: 30 }], Date.now());
    const { alerts } = await tick(harness, rainAt10({ chance: 0.95, intensity: 0 }));
    expect(alerts).toEqual([]);
  });

  it('sends nothing at all for a dry hour', async () => {
    const harness = makeHarness({ signingKey });
    await plant(harness, [{ n: 1, leadTimeMinutes: 60 }], Date.now());
    const { alerts } = await tick(harness, (t) => forecast(t, () => false));
    expect(alerts).toEqual([]);
  });
});
