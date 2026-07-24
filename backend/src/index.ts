import { Env, DeviceRegistration } from './types';
import { getDevicesByGrid, gridCenter, toGridKey } from './grid';
import { fetchForecast } from './weatherkit';
import { sendRainAlert, sendRainEndAlert, intensityFromMmPerHr } from './apns';

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
            }
          }
          if (rainEnd && device.rainEndEnabled !== false) {
            const minutesUntilEnd = Math.round((new Date(rainEnd.startTime).getTime() - now) / 60000);
            if (minutesUntilEnd <= 30 && minutesUntilEnd >= -5) {
              await notifyOnce(device, 'end', () => sendRainEndAlert(device.token, env, minutesUntilEnd));
              console.log(`[Cron] Rain-end grid ${grid.gridKey}, in ${minutesUntilEnd}m`);
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
