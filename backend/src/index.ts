import { Env, DeviceRegistration, LiveActivityContentState } from './types';
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
import {
  DEVICE_RECORD_TTL_SECONDS,
  MAX_GRID_CELLS,
  checkRegistrationRate,
  recordGridCellCount,
  reserveGridCell,
  selectCellsWithinCap,
} from './abuse';

// Live Activity segment math is normalized over this window, matching the widget's ring.
const ACTIVITY_WINDOW_MINUTES = 90;

// How many BadDeviceToken rejections a device may collect before we drop it.
// See recordPushFailure for why this isn't 1.
const BAD_TOKEN_STRIKES = 5;

function json(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
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

// A cross-origin POST with `Content-Type: text/plain` is a CORS "simple
// request": no preflight, so any web page could make each of its visitors
// register a device, spreading a flood across thousands of residential IPs —
// exactly the shape a per-client throttle cannot see. Demanding
// application/json forces a preflight, which, since we send no
// Access-Control-Allow-Origin, browsers refuse. Non-browser clients are
// unaffected; throttling them is the rate limiter's job, not this check's.
function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get('Content-Type') ?? '';
  return contentType.split(';')[0].trim().toLowerCase() === 'application/json';
}

// Front door for every state-changing endpoint. Returns a response to send
// instead of running the handler, or null to proceed.
//
// Every rejection here says what happened and when to come back, because the
// alternative — dropping a real user's registration on the floor and returning
// something they cannot act on — is how a rate limit turns into a silent
// outage.
async function guardMutation(
  request: Request,
  env: Env,
  options: { throttle: boolean }
): Promise<Response | null> {
  if (!hasJsonContentType(request)) {
    return json(
      {
        error: 'Content-Type must be application/json.',
        code: 'unsupported_media_type',
      },
      415
    );
  }

  if (!options.throttle) return null;

  const rate = await checkRegistrationRate(request, env);
  if (!rate.ok) {
    console.log(`[Abuse] Throttled a registration request for ${rate.retryAfterSeconds}s`);
    return json(
      {
        error:
          'Too many registration requests from this network. Alerts already set up are unaffected; retry shortly.',
        code: 'rate_limited',
        retryAfterSeconds: rate.retryAfterSeconds,
      },
      429,
      { 'Retry-After': String(rate.retryAfterSeconds) }
    );
  }

  return null;
}

export default {
  // HTTP API for device registration
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // /register and /register-activity are throttled: they are the two routes
    // that grow stored state and, through it, the cron's WeatherKit bill. The
    // two teardown routes are only content-type checked — a user leaving should
    // never be told to come back later.
    if (request.method === 'POST' && url.pathname === '/register') {
      return (await guardMutation(request, env, { throttle: true })) ?? handleRegister(request, env);
    }

    if (request.method === 'DELETE' && url.pathname === '/unregister') {
      return (
        (await guardMutation(request, env, { throttle: false })) ?? handleUnregister(request, env)
      );
    }

    if (request.method === 'POST' && url.pathname === '/register-activity') {
      return (
        (await guardMutation(request, env, { throttle: true })) ??
        handleRegisterActivity(request, env)
      );
    }

    if (request.method === 'POST' && url.pathname === '/unregister-activity') {
      return (
        (await guardMutation(request, env, { throttle: false })) ??
        handleUnregisterActivity(request, env)
      );
    }

    if (request.method === 'POST' && url.pathname === '/test-rain') {
      if (!isAuthorizedAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
      return handleTestRain(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/test-cron') {
      if (!isAuthorizedAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
      return handleTestCron(request, env);
    }

    return new Response('Not found', { status: 404 });
  },

  // Cron trigger: check weather for all registered devices
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const allGrids = await getDevicesByGrid(env);

    // Publish the true distinct-cell count so /register budgets against
    // reality rather than against a counter that has drifted.
    await recordGridCellCount(allGrids.length, env);

    // One WeatherKit fetch per cell, all inside this one invocation: without a
    // ceiling here, enough registrations exhaust the monthly quota and, on the
    // Free plan, blow the 50-subrequest limit and take the whole tick down.
    const { cells: grids, skipped } = selectCellsWithinCap(allGrids);
    if (skipped > 0) {
      console.error(
        `[Cron] Grid-cell cap hit: serving the ${grids.length} oldest of ${allGrids.length} cells, ` +
          `skipping ${skipped}. Cap is MAX_GRID_CELLS=${MAX_GRID_CELLS}; raising it needs the ` +
          `quota arithmetic in abuse.ts re-run and a Paid Workers plan above 50.`
      );
    }
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
                    statusText: 'Rain incoming',
                    countdownTarget: encodeActivityDate(new Date(now + minutesUntilRain * 60000)),
                    heroText: null,
                    subBold: 'Rain expected',
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
                    statusText: 'Raining now',
                    countdownTarget: encodeActivityDate(new Date(now + minutesUntilEnd * 60000)),
                    heroText: null,
                    subBold: `stops in about ${minutesUntilEnd} min`,
                    subRest: 'Raining · ',
                    boldFirst: false,
                    rightText: '',
                    segments,
                    windowMinutes: ACTIVITY_WINDOW_MINUTES,
                    midLabel: '+45 min',
                    endLabel: '+90 min',
                    flagText: null,
                    flagPosition: null,
                  };
                  await sendLiveActivityUpdate(device.activityToken, contentState, env);
                } else {
                  const contentState: LiveActivityContentState = {
                    statusText: 'Rain ended',
                    countdownTarget: null,
                    heroText: 'Clear',
                    subBold: 'Rain has stopped',
                    subRest: '',
                    boldFirst: true,
                    rightText: '',
                    segments: [],
                    windowMinutes: ACTIVITY_WINDOW_MINUTES,
                    midLabel: '+45 min',
                    endLabel: '+90 min',
                    flagText: null,
                    flagPosition: null,
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

// Every write of a `device:` record goes through here so none can silently
// re-create the immortal, TTL-less record this replaced. Re-writing resets the
// clock, which is correct: every path that writes one is driven by a live
// device — a registration, a Live Activity the device started, or a push it
// accepted.
async function putDeviceRecord(
  deviceToken: string,
  registration: DeviceRegistration,
  env: Env
): Promise<void> {
  await env.DEVICES.put(`device:${deviceToken}`, JSON.stringify(registration), {
    expirationTtl: DEVICE_RECORD_TTL_SECONDS,
  });
}

// Drop the stored activity token once its Live Activity has been ended.
async function clearActivityToken(deviceToken: string, env: Env): Promise<void> {
  const key = `device:${deviceToken}`;
  const existing = await env.DEVICES.get(key, 'json');
  if (!existing) return;

  const registration = existing as DeviceRegistration;
  delete registration.activityToken;
  delete registration.activityUpdatedAt;
  await putDeviceRecord(deviceToken, registration, env);
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

async function handleTestCron(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ token?: unknown; lat?: unknown; lon?: unknown }>(request);
  if (!body) return json({ error: 'Malformed JSON body' }, 400);

  if (!isValidDeviceToken(body.token)) {
    return json({ error: 'Invalid or missing token' }, 400);
  }
  if (!isValidLatitude(body.lat) || !isValidLongitude(body.lon)) {
    return json({ error: 'Invalid or missing lat/lon' }, 400);
  }

  try {
    const forecast = await fetchForecast(body.lat, body.lon, env);
    const minutes = forecast.forecastNextHour?.minutes;

    if (!minutes || minutes.length === 0) {
      return new Response(JSON.stringify({ ok: true, result: 'no_forecast_data' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const now = Date.now();
    const rainStart = minutes.find(
      (m) => m.precipitationChance > 0.3 && m.precipitationIntensity > 0
    );

    if (!rainStart) {
      return new Response(JSON.stringify({ ok: true, result: 'no_rain', minutesChecked: minutes.length }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const rainStartTime = new Date(rainStart.startTime).getTime();
    const minutesUntilRain = Math.round((rainStartTime - now) / 60000);

    await sendRainAlert(body.token, minutesUntilRain, env);
    return new Response(JSON.stringify({
      ok: true,
      result: 'rain_detected',
      minutesUntilRain,
      precipitationChance: rainStart.precipitationChance,
      precipitationIntensity: rainStart.precipitationIntensity,
    }), {
      headers: { 'Content-Type': 'application/json' },
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

  const gridKey = toGridKey(body.lat, body.lon);

  // Opening a *new* grid cell is the expensive act: it adds ~4,383 WeatherKit
  // calls a month, forever. Registering into a cell the service already covers
  // costs nothing extra and is always allowed, so an existing user is never
  // turned away by the cap.
  const cell = await reserveGridCell(gridKey, env);
  if (!cell.ok) {
    console.error(
      `[Register] Refused a new grid cell: at capacity (${cell.cells}/${MAX_GRID_CELLS} cells)`
    );
    return json(
      {
        error:
          'This service is at its coverage limit and cannot take on a new area right now. ' +
          'Alerts for areas already covered are unaffected.',
        code: 'coverage_at_capacity',
        maxGridCells: MAX_GRID_CELLS,
      },
      503,
      { 'Retry-After': '3600' }
    );
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
    // write happened, not what was written. The record carries a TTL, which is
    // what makes junk transient: a live install refreshes its own on every
    // foreground, a fabricated one never does (see DEVICE_RECORD_TTL_SECONDS).
    await putDeviceRecord(body.token, registration, env);
    console.log(`[Register] Stored registration for grid ${gridKey}`);
  } catch (err) {
    console.error(`[Register] KV write failed: ${err}`);
    return json({ error: 'KV write failed' }, 500);
  }

  return json({ ok: true, gridKey });
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

  await putDeviceRecord(body.token, registration, env);
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
    await putDeviceRecord(body.token, registration, env);
    console.log(`[Activity] Unregistered activity token for device`);
  }

  return json({ ok: true });
}
