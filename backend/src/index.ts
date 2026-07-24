import { Env, DeviceRegistration, LiveActivityContentState } from './types';
import { getDevicesByGrid, gridCenter, toGridKey } from './grid';
import { fetchForecast } from './weatherkit';
import { sendRainAlert, sendRainEndAlert, sendLiveActivityUpdate, encodeActivityDate, intensityFromMmPerHr } from './apns';

// Live Activity segment math is normalized over this window, matching the widget's ring.
const ACTIVITY_WINDOW_MINUTES = 90;

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
      return handleTestRain(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/test-cron') {
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
  const body = (await request.json()) as { token?: string; minutesUntilRain?: number };

  if (!body.token) {
    return new Response(JSON.stringify({ error: 'Missing token' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const minutesUntilRain = body.minutesUntilRain ?? 10;

  try {
    await sendRainAlert(body.token, minutesUntilRain, env);
    return new Response(JSON.stringify({ ok: true, minutesUntilRain }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function handleTestCron(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { token?: string; lat?: number; lon?: number };

  if (!body.token || body.lat == null || body.lon == null) {
    return new Response(JSON.stringify({ error: 'Missing token, lat, or lon' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
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
  const body = (await request.json()) as {
    token?: string;
    lat?: number;
    lon?: number;
    leadTimeMinutes?: number;
    rainStartEnabled?: boolean;
    rainEndEnabled?: boolean;
  };

  if (!body.token || body.lat == null || body.lon == null) {
    return new Response(JSON.stringify({ error: 'Missing token, lat, or lon' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const registration: DeviceRegistration = {
    token: body.token,
    lat: body.lat,
    lon: body.lon,
    leadTimeMinutes: body.leadTimeMinutes ?? 20,
    rainStartEnabled: body.rainStartEnabled ?? true,
    rainEndEnabled: body.rainEndEnabled ?? true,
    registeredAt: new Date().toISOString(),
  };

  // Key by device token for easy lookup/update
  try {
    const key = `device:${body.token}`;
    const value = JSON.stringify(registration);
    console.log(`[Register] Writing key=${key} value=${value}`);
    await env.DEVICES.put(key, value);
    console.log(`[Register] Write successful`);
  } catch (err) {
    console.error(`[Register] KV write failed: ${err}`);
    return new Response(JSON.stringify({ error: 'KV write failed', details: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true, gridKey: toGridKey(body.lat, body.lon) }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleUnregister(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { token?: string };
  if (!body.token) {
    return new Response(JSON.stringify({ error: 'Missing token' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  await env.DEVICES.delete(`device:${body.token}`);
  await env.DEVICES.delete(`notified:${body.token}`);

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleRegisterActivity(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { token?: string; activityToken?: string };

  if (!body.token || !body.activityToken) {
    return new Response(JSON.stringify({ error: 'Missing token or activityToken' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const key = `device:${body.token}`;
  const existing = await env.DEVICES.get(key, 'json');
  if (!existing) {
    console.log(`[Activity] Register failed: no device for token`);
    return new Response(JSON.stringify({ error: 'Device not registered' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const registration = existing as DeviceRegistration;
  registration.activityToken = body.activityToken;
  registration.activityUpdatedAt = new Date().toISOString();

  await env.DEVICES.put(key, JSON.stringify(registration));
  console.log(`[Activity] Registered activity token for device`);

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleUnregisterActivity(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { token?: string };
  if (!body.token) {
    return new Response(JSON.stringify({ error: 'Missing token' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
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

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
