import { Env, DeviceRegistration, LiveActivityContentState, Precip, WeatherKitForecast } from './types';
import { getDevicesByGrid, gridCenter, toGridKey } from './grid';
import { fetchForecast } from './weatherkit';
import {
  APNsError,
  sendRainAlert,
  sendRainEndAlert,
  sendLiveActivityUpdate,
  encodeActivityDate,
  intensityFromMmPerHr,
} from './apns';
import {
  asBoolean,
  clampLeadTimeMinutes,
  isValidLatitude,
  isValidLongitude,
  isValidActivityToken,
  isValidDeviceToken,
  secureEquals,
} from './validate';

// Live Activity segment math is normalized over this window, matching the widget's ring.
const ACTIVITY_WINDOW_MINUTES = 90;

// How many BadDeviceToken rejections a device may collect before we drop it.
// See recordPushFailure for why this isn't 1.
const BAD_TOKEN_STRIKES = 5;

// WeatherKit condition strings that should render with the wintry treatment.
// Anything with ice in it groups together; everything else is rain.
const WINTRY_CONDITIONS = new Set(['snow', 'sleet', 'hail', 'mixed', 'flurries', 'wintrymix']);

// Server-side copy, kept in step with `precip`. Without this the widget would
// draw a snowflake next to the word "rain".
function copyFor(precip: Precip) {
  const wintry = precip === 'wintry';
  return {
    incoming: wintry ? 'Snow incoming' : 'Rain incoming',
    expected: wintry ? 'Snow expected' : 'Rain expected',
    fallingNow: wintry ? 'Snowing now' : 'Raining now',
    fallingVerb: wintry ? 'Snowing · ' : 'Raining · ',
    ended: wintry ? 'Snow ended' : 'Rain ended',
    hasStopped: wintry ? 'Snow has stopped' : 'Rain has stopped',
  };
}

// Reads the precipitation type out of forecastNextHour's summary rollup.
//
// The per-minute entries carry only chance and intensity, so the summary is the
// sole source of type in this dataset. Every field is treated as possibly
// absent: if Apple changes the schema, or the summary contains only "clear",
// this returns 'rain' — both the old behaviour and the right default for a rain
// app. It never throws.
function precipFromForecast(forecast: WeatherKitForecast): Precip {
  const summary = forecast.forecastNextHour?.summary;
  if (!summary?.length) return 'rain';

  for (const period of summary) {
    const condition = period.condition?.toLowerCase().replace(/[\s_-]/g, '');
    if (!condition || condition === 'clear') continue;
    return WINTRY_CONDITIONS.has(condition) ? 'wintry' : 'rain';
  }
  return 'rain';
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// A malformed body should be a 400, not an unhandled throw that surfaces as a
// generic Worker 500.
async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

// /test-rain and /test-cron send real pushes and burn real WeatherKit quota, so
// they require a shared secret. Fails closed: if ADMIN_TOKEN was never set, the
// endpoints are unusable rather than open.
function isAuthorizedAdmin(request: Request, env: Env): boolean {
  const provided = request.headers.get('X-Admin-Token');
  if (!env.ADMIN_TOKEN || !provided) return false;
  return secureEquals(provided, env.ADMIN_TOKEN);
}

export default {
  // HTTP API for device registration
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/register') {
      return handleRegister(request, env);
    }

    if (request.method === 'DELETE' && url.pathname === '/unregister') {
      return handleUnregister(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/register-activity') {
      return handleRegisterActivity(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/unregister-activity') {
      return handleUnregisterActivity(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/test-rain') {
      if (!isAuthorizedAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
      return handleTestRain(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/test-activity') {
      if (!isAuthorizedAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
      return handleTestActivity(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/test-cron') {
      if (!isAuthorizedAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
      return handleTestCron(request, env);
    }

    return new Response('Not found', { status: 404 });
  },

  // Cron trigger: check weather for all registered devices
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const grids = await getDevicesByGrid(env);
    console.log(`[Cron] Processing ${grids.length} grid cells`);

    const promises = grids.map(async (grid) => {
      const { lat, lon } = gridCenter(grid.gridKey);
      try {
        const forecast = await fetchForecast(lat, lon, env);
        const minutes = forecast.forecastNextHour?.minutes;
        if (!minutes || minutes.length === 0) return;

        const now = Date.now();
        const isWet = (m: { precipitationChance: number; precipitationIntensity: number }) =>
          m.precipitationChance > 0.3 && m.precipitationIntensity > 0;
        const rainingNow = isWet(minutes[0]);

        // Rain START: first wet minute ahead — only relevant if it isn't already raining.
        const rainStart = rainingNow ? undefined : minutes.find(isWet);
        // Rain END: if it's raining now, the first upcoming dry minute (rain tapering off).
        const rainEnd = rainingNow ? minutes.find((m) => !isWet(m)) : undefined;

        if (!rainStart && !rainEnd) return;

        const precip = precipFromForecast(forecast);
        const copy = copyFor(precip);
        // Logged so the summary schema can be confirmed against real responses
        // rather than trusted from Apple's docs — see the 1.1.1 spec.
        console.log(
          `[Cron] Grid ${grid.gridKey} precip=${precip} summary=` +
            JSON.stringify(forecast.forecastNextHour?.summary?.map((s) => s.condition) ?? null)
        );

        // At most one push per device per event type, deduped for 30 min via KV.
        const notifyOnce = async (
          device: DeviceRegistration,
          kind: 'start' | 'end',
          send: () => Promise<void>
        ) => {
          const metaKey = `notified-${kind}:${device.token}`;
          const lastNotified = await env.DEVICES.get(metaKey);
          if (lastNotified && now - parseInt(lastNotified) < 30 * 60 * 1000) return;
          try {
            await send();
            await env.DEVICES.put(metaKey, now.toString(), { expirationTtl: 3600 });
          } catch (err) {
            console.error(`[Cron] Failed to notify device (${kind}): ${err}`);
            await recordPushFailure(device.token, err, env);
          }
        };

        for (const device of grid.devices) {
          if (rainStart && device.rainStartEnabled !== false) {
            const minutesUntilRain = Math.round((new Date(rainStart.startTime).getTime() - now) / 60000);
            if (minutesUntilRain <= device.leadTimeMinutes && minutesUntilRain >= -5) {
              await notifyOnce(device, 'start', () =>
                sendRainAlert(device.token, minutesUntilRain, env, intensityFromMmPerHr(rainStart.precipitationIntensity))
              );
              console.log(`[Cron] Rain-start grid ${grid.gridKey}, in ${minutesUntilRain}m`);

              // Live Activity: rain incoming (State A). Only relevant within the same
              // lead-time window as the alert above; a push failure here must never
              // break the alert-push loop.
              if (device.activityToken) {
                try {
                  const segments = computeSegments(minutes, isWet, now, ACTIVITY_WINDOW_MINUTES);
                  const contentState: LiveActivityContentState = {
                    statusText: copy.incoming,
                    countdownTarget: encodeActivityDate(new Date(now + minutesUntilRain * 60000)),
                    heroText: null,
                    subBold: copy.expected,
                    subRest: ' · next hour',
                    boldFirst: true,
                    rightText: '',
                    segments,
                    windowMinutes: ACTIVITY_WINDOW_MINUTES,
                    midLabel: '+45 min',
                    endLabel: '+90 min',
                    // No flag from the server: DeviceRegistration has no timezone, so a
                    // clock time would render in UTC. The app's own refreshes set it.
                    flagText: null,
                    flagPosition: null,
                    precip,
                  };
                  await sendLiveActivityUpdate(device.activityToken, contentState, env);
                  console.log(`[Activity] Sent rain-start update, grid ${grid.gridKey}`);
                } catch (err) {
                  console.error(`[Activity] push failed: ${err}`);
                  await discardDeadActivityToken(device.token, err, env);
                }
              }
            }
          }
          if (rainEnd && device.rainEndEnabled !== false) {
            const minutesUntilEnd = Math.round((new Date(rainEnd.startTime).getTime() - now) / 60000);
            if (minutesUntilEnd <= 30 && minutesUntilEnd >= -5) {
              await notifyOnce(device, 'end', () => sendRainEndAlert(device.token, env, minutesUntilEnd));
              console.log(`[Cron] Rain-end grid ${grid.gridKey}, in ${minutesUntilEnd}m`);
            }

            // Live Activity: keep the countdown live every cron tick while it's still
            // raining (State B), independent of the alert's 30-min/dedup gate above.
            // Once the dry minute actually arrives, send the terminal state and drop
            // the activity token — a push failure here must never break the alert loop.
            if (device.activityToken) {
              try {
                if (minutesUntilEnd > 0) {
                  const segments = computeSegments(minutes, isWet, now, ACTIVITY_WINDOW_MINUTES);
                  const contentState: LiveActivityContentState = {
                    statusText: copy.fallingNow,
                    countdownTarget: encodeActivityDate(new Date(now + minutesUntilEnd * 60000)),
                    heroText: null,
                    subBold: `stops in about ${minutesUntilEnd} min`,
                    subRest: copy.fallingVerb,
                    boldFirst: false,
                    rightText: '',
                    segments,
                    windowMinutes: ACTIVITY_WINDOW_MINUTES,
                    midLabel: '+45 min',
                    endLabel: '+90 min',
                    flagText: null,
                    flagPosition: null,
                    precip,
                  };
                  await sendLiveActivityUpdate(device.activityToken, contentState, env);
                } else {
                  const contentState: LiveActivityContentState = {
                    statusText: copy.ended,
                    countdownTarget: null,
                    heroText: 'Clear',
                    subBold: copy.hasStopped,
                    subRest: '',
                    boldFirst: true,
                    rightText: '',
                    segments: [],
                    windowMinutes: ACTIVITY_WINDOW_MINUTES,
                    midLabel: '+45 min',
                    endLabel: '+90 min',
                    flagText: null,
                    flagPosition: null,
                    precip,
                  };
                  await sendLiveActivityUpdate(device.activityToken, contentState, env, 'end');
                  await clearActivityToken(device.token, env);
                  console.log(`[Activity] Sent rain-end (final) update, grid ${grid.gridKey}`);
                }
              } catch (err) {
                console.error(`[Activity] push failed: ${err}`);
                await discardDeadActivityToken(device.token, err, env);
              }
            }
          }
        }
      } catch (err) {
        console.error(`[Cron] Failed to fetch weather for grid ${grid.gridKey}: ${err}`);
      }
    });

    await Promise.all(promises);
  },
};

// Collapse the minute-by-minute forecast into contiguous wet stretches, normalized
// to 0...1 fractions of `windowMinutes` — this is what the Live Activity ring/bar
// renders. WeatherKit's forecastNextHour only covers ~60 minutes, so a 90-minute
// window will simply have no segment data past that point.
function computeSegments(
  minutes: Array<{ startTime: string; precipitationChance: number; precipitationIntensity: number }>,
  isWet: (m: { precipitationChance: number; precipitationIntensity: number }) => boolean,
  now: number,
  windowMinutes: number
): Array<{ start: number; end: number }> {
  const segments: Array<{ start: number; end: number }> = [];
  let stretchStartMinutes: number | null = null;

  for (const m of minutes) {
    const offsetMinutes = (new Date(m.startTime).getTime() - now) / 60000;
    if (offsetMinutes > windowMinutes) break;

    if (isWet(m)) {
      if (stretchStartMinutes === null) stretchStartMinutes = Math.max(0, offsetMinutes);
    } else if (stretchStartMinutes !== null) {
      segments.push({ start: stretchStartMinutes / windowMinutes, end: offsetMinutes / windowMinutes });
      stretchStartMinutes = null;
    }
  }
  if (stretchStartMinutes !== null) {
    segments.push({ start: stretchStartMinutes / windowMinutes, end: 1 });
  }

  return segments;
}


// A rejected Live Activity push means the activity itself is over — the user
// dismissed it, or it aged out — not that the device is gone. Drop only the
// activity token so the device keeps receiving ordinary rain alerts, and stop
// pushing to a token APNs has already refused.
async function discardDeadActivityToken(deviceToken: string, err: unknown, env: Env): Promise<void> {
  if (!(err instanceof APNsError)) return;
  if (!err.isUnregistered && !err.isBadDeviceToken) return;
  await clearActivityToken(deviceToken, env);
  console.log(`[Activity] Cleared dead activity token (${err.reason})`);
}

// Drop the stored activity token once its Live Activity has been ended.
async function clearActivityToken(deviceToken: string, env: Env): Promise<void> {
  const key = `device:${deviceToken}`;
  const existing = await env.DEVICES.get(key, 'json');
  if (!existing) return;

  const registration = existing as DeviceRegistration;
  delete registration.activityToken;
  delete registration.activityUpdatedAt;
  await env.DEVICES.put(key, JSON.stringify(registration));
}

async function handleTestRain(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ token?: unknown; minutesUntilRain?: unknown }>(request);
  if (!body) return json({ error: 'Malformed JSON body' }, 400);

  if (!isValidDeviceToken(body.token)) {
    return json({ error: 'Invalid or missing token' }, 400);
  }

  const minutesUntilRain =
    typeof body.minutesUntilRain === 'number' && Number.isFinite(body.minutesUntilRain)
      ? Math.round(body.minutesUntilRain)
      : 10;

  try {
    await sendRainAlert(body.token, minutesUntilRain, env);
    return json({ ok: true, minutesUntilRain });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

// Pushes a content-state at a device's live activity, on demand.
//
// This is the only way to exercise the server -> Live Activity path without
// waiting for real weather: the cron pushes activity updates, but only for a
// device that has an activityToken AND sits in a grid that is currently
// precipitating. Until this existed the path had never run against a real
// activity token even once.
//
// It matters most for `precip`. `content-state` is a full replacement, so the
// server's payload — not the app's — decides whether a card reads as snow or
// rain from the next tick onward. `precip: null` reproduces a pre-1.1.1 Worker
// and must leave the card ticking in rain colours rather than freezing it.
async function handleTestActivity(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{
    token?: unknown; precip?: unknown; event?: unknown; minutesUntil?: unknown;
  }>(request);
  if (!body) return json({ error: 'Malformed JSON body' }, 400);

  if (!isValidDeviceToken(body.token)) {
    return json({ error: 'Invalid or missing token' }, 400);
  }

  const registration = await env.DEVICES.get<DeviceRegistration>(`device:${body.token}`, 'json');
  if (!registration) return json({ error: 'Device not registered' }, 404);
  if (!registration.activityToken) {
    return json({
      error: 'Device has no activityToken — no Live Activity is running, or the '
        + 'app never reported its push token',
    }, 409);
  }

  // Explicit null is meaningful here (the legacy-payload case), so absence and
  // null must be told apart: only an actual 'wintry' or 'rain' sets the field.
  const precip: Precip | undefined =
    body.precip === 'wintry' ? 'wintry' : body.precip === 'rain' ? 'rain' : undefined;
  const event = body.event === 'end' ? 'end' : 'update';
  const minutesUntil =
    typeof body.minutesUntil === 'number' && Number.isFinite(body.minutesUntil)
      ? Math.round(body.minutesUntil)
      : 25;
  const copy = copyFor(precip ?? 'rain');

  // `precip` is required on LiveActivityContentState precisely so no production
  // path can forget it — a payload without it silently reverts a snowing card
  // to rain. This test needs to send exactly that payload on purpose, so it
  // relaxes the field here and nowhere else.
  const contentState: Omit<LiveActivityContentState, 'precip'> & { precip?: Precip } = {
    statusText: copy.incoming,
    countdownTarget: encodeActivityDate(new Date(Date.now() + minutesUntil * 60000)),
    heroText: null,
    subBold: copy.expected,
    subRest: ' · test push',
    boldFirst: true,
    rightText: 'Test',
    segments: [{ start: 0.2, end: 0.6 }],
    windowMinutes: ACTIVITY_WINDOW_MINUTES,
    midLabel: '+45 min',
    endLabel: '+90 min',
    flagText: null,
    flagPosition: null,
  };
  if (precip) contentState.precip = precip;

  try {
    await sendLiveActivityUpdate(registration.activityToken, contentState, env, event);
    return json({ ok: true, event, precip: precip ?? null, minutesUntil });
  } catch (err) {
    await discardDeadActivityToken(body.token, err, env);
    return json({ error: String(err) }, 500);
  }
}

// Runs the cron's detection logic for one coordinate and reports what it saw.
//
// `dryRun: true` skips the push, which makes this usable as a plain forecast
// probe against any coordinate — no device has to exist there and nobody's
// phone buzzes. That is the only way to answer "does WeatherKit actually
// populate forecastNextHour.summary[].condition, and with what values?", since
// the cron's own summary log only fires for a grid that already has a
// registered device AND active precipitation.
async function handleTestCron(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{
    token?: unknown; lat?: unknown; lon?: unknown; dryRun?: unknown;
  }>(request);
  if (!body) return json({ error: 'Malformed JSON body' }, 400);

  if (!isValidDeviceToken(body.token)) {
    return json({ error: 'Invalid or missing token' }, 400);
  }
  if (!isValidLatitude(body.lat) || !isValidLongitude(body.lon)) {
    return json({ error: 'Invalid or missing lat/lon' }, 400);
  }
  const dryRun = body.dryRun === true;

  try {
    const forecast = await fetchForecast(body.lat, body.lon, env);
    const minutes = forecast.forecastNextHour?.minutes;

    // The raw conditions, not just the derived value: if Apple renames a case
    // or ships one WINTRY_CONDITIONS does not know about, `precip` alone would
    // read as a confident "rain" and hide it.
    const summary = forecast.forecastNextHour?.summary?.map((s) => s.condition) ?? null;
    const diagnostics = { precip: precipFromForecast(forecast), summary, dryRun };

    if (!minutes || minutes.length === 0) {
      return json({ ok: true, result: 'no_forecast_data', ...diagnostics });
    }

    const now = Date.now();
    const rainStart = minutes.find(
      (m) => m.precipitationChance > 0.3 && m.precipitationIntensity > 0
    );

    if (!rainStart) {
      return json({ ok: true, result: 'no_rain', minutesChecked: minutes.length, ...diagnostics });
    }

    const rainStartTime = new Date(rainStart.startTime).getTime();
    const minutesUntilRain = Math.round((rainStartTime - now) / 60000);

    if (!dryRun) {
      await sendRainAlert(body.token, minutesUntilRain, env);
    }
    return json({
      ok: true,
      result: 'rain_detected',
      minutesUntilRain,
      precipitationChance: rainStart.precipitationChance,
      precipitationIntensity: rainStart.precipitationIntensity,
      ...diagnostics,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function handleRegister(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{
    token?: unknown;
    lat?: unknown;
    lon?: unknown;
    leadTimeMinutes?: unknown;
    rainStartEnabled?: unknown;
    rainEndEnabled?: unknown;
  }>(request);
  if (!body) return json({ error: 'Malformed JSON body' }, 400);

  if (!isValidDeviceToken(body.token)) {
    return json({ error: 'Invalid or missing token' }, 400);
  }
  if (!isValidLatitude(body.lat) || !isValidLongitude(body.lon)) {
    return json({ error: 'Invalid or missing lat/lon' }, 400);
  }

  const registration: DeviceRegistration = {
    token: body.token,
    lat: body.lat,
    lon: body.lon,
    leadTimeMinutes: clampLeadTimeMinutes(body.leadTimeMinutes),
    rainStartEnabled: asBoolean(body.rainStartEnabled, true),
    rainEndEnabled: asBoolean(body.rainEndEnabled, true),
    registeredAt: new Date().toISOString(),
  };

  // Key by device token for easy lookup/update
  try {
    // Location and push token are the two pieces of user data here — log that a
    // write happened, not what was written.
    await env.DEVICES.put(`device:${body.token}`, JSON.stringify(registration));
    console.log(`[Register] Stored registration for grid ${toGridKey(body.lat, body.lon)}`);
  } catch (err) {
    console.error(`[Register] KV write failed: ${err}`);
    return json({ error: 'KV write failed' }, 500);
  }

  return json({ ok: true, gridKey: toGridKey(body.lat, body.lon) });
}

async function handleUnregister(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ token?: unknown }>(request);
  if (!body) return json({ error: 'Malformed JSON body' }, 400);
  if (!isValidDeviceToken(body.token)) {
    return json({ error: 'Invalid or missing token' }, 400);
  }

  await removeDevice(body.token, env);

  return json({ ok: true });
}

// Drops a device and every key keyed off its token. The dedup keys the cron
// writes are `notified-start:` / `notified-end:`; an earlier version deleted a
// `notified:` key that nothing has ever written.
async function removeDevice(deviceToken: string, env: Env): Promise<void> {
  await Promise.all([
    env.DEVICES.delete(`device:${deviceToken}`),
    env.DEVICES.delete(`notified-start:${deviceToken}`),
    env.DEVICES.delete(`notified-end:${deviceToken}`),
    env.DEVICES.delete(`apnsfail:${deviceToken}`),
  ]);
}

// Decides whether a push failure means the device is gone.
//
// A 410 is APNs stating outright that the token is dead, so act on it at once.
// BadDeviceToken needs more care: it is also what every single device returns
// when APNS_ENV points at the wrong APNs host, so treating one as fatal would
// let a config typo wipe the whole device list in a single cron tick. Requiring
// several strikes inside the counter's 24h TTL keeps that from happening, and
// still clears genuinely dead tokens within an hour. The app re-registers on
// every foreground, so an over-eager delete heals itself.
async function recordPushFailure(deviceToken: string, err: unknown, env: Env): Promise<void> {
  if (!(err instanceof APNsError)) return;

  if (err.isUnregistered) {
    await removeDevice(deviceToken, env);
    console.log(`[APNs] Dropped unregistered device token`);
    return;
  }

  if (!err.isBadDeviceToken) return;

  const key = `apnsfail:${deviceToken}`;
  const strikes = parseInt((await env.DEVICES.get(key)) ?? '0', 10) + 1;
  if (strikes >= BAD_TOKEN_STRIKES) {
    await removeDevice(deviceToken, env);
    console.log(`[APNs] Dropped device after ${strikes} BadDeviceToken rejections`);
  } else {
    await env.DEVICES.put(key, String(strikes), { expirationTtl: 86400 });
    console.log(`[APNs] BadDeviceToken strike ${strikes}/${BAD_TOKEN_STRIKES}`);
  }
}

async function handleRegisterActivity(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ token?: unknown; activityToken?: unknown }>(request);
  if (!body) return json({ error: 'Malformed JSON body' }, 400);

  if (!isValidDeviceToken(body.token) || !isValidActivityToken(body.activityToken)) {
    return json({ error: 'Invalid or missing token or activityToken' }, 400);
  }

  const key = `device:${body.token}`;
  const existing = await env.DEVICES.get(key, 'json');
  if (!existing) {
    console.log(`[Activity] Register failed: no device for token`);
    return json({ error: 'Device not registered' }, 404);
  }

  const registration = existing as DeviceRegistration;
  registration.activityToken = body.activityToken;
  registration.activityUpdatedAt = new Date().toISOString();

  await env.DEVICES.put(key, JSON.stringify(registration));
  console.log(`[Activity] Registered activity token for device`);

  return json({ ok: true });
}

async function handleUnregisterActivity(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ token?: unknown }>(request);
  if (!body) return json({ error: 'Malformed JSON body' }, 400);
  if (!isValidDeviceToken(body.token)) {
    return json({ error: 'Invalid or missing token' }, 400);
  }

  const key = `device:${body.token}`;
  const existing = await env.DEVICES.get(key, 'json');
  if (existing) {
    const registration = existing as DeviceRegistration;
    delete registration.activityToken;
    delete registration.activityUpdatedAt;
    await env.DEVICES.put(key, JSON.stringify(registration));
    console.log(`[Activity] Unregistered activity token for device`);
  }

  return json({ ok: true });
}
