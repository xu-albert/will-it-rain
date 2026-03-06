import { Env, DeviceRegistration, CronLogEntry, GridLogEntry } from './types';
import { getDevicesByGrid, gridCenter, toGridKey } from './grid';
import { fetchForecast } from './weatherkit';
import { sendRainAlert } from './apns';

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

    if (request.method === 'GET' && url.pathname === '/debug/status') {
      const tokenPrefix = url.searchParams.get('token');
      if (!tokenPrefix) {
        return new Response(JSON.stringify({ error: 'Pass ?token=<first 8+ chars of your device token>' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return handleDebugStatus(tokenPrefix, env);
    }

    if (request.method === 'GET' && url.pathname === '/debug/logs') {
      return handleDebugLogs(env);
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
    const now = Date.now();
    const cronLog: CronLogEntry = {
      timestamp: new Date(now).toISOString(),
      gridResults: [],
    };

    const promises = grids.map(async (grid) => {
      const { lat, lon } = gridCenter(grid.gridKey);
      const gridLog: GridLogEntry = {
        gridKey: grid.gridKey,
        lat,
        lon,
        deviceCount: grid.devices.length,
        deviceTokenPrefixes: grid.devices.map((d) => d.token.substring(0, 8)),
        forecastResult: 'no_data',
        notificationsSent: [],
      };

      try {
        const forecast = await fetchForecast(lat, lon, env);
        const minutes = forecast.forecastNextHour?.minutes;
        if (!minutes || minutes.length === 0) {
          cronLog.gridResults.push(gridLog);
          return;
        }

        // Find first minute with precipitation
        const rainStart = minutes.find(
          (m) => m.precipitationChance > 0.3 && m.precipitationIntensity > 0
        );

        if (!rainStart) {
          gridLog.forecastResult = 'clear';
          cronLog.gridResults.push(gridLog);
          return;
        }

        const rainStartTime = new Date(rainStart.startTime).getTime();
        const minutesUntilRain = Math.round((rainStartTime - now) / 60000);
        gridLog.forecastResult = 'rain';
        gridLog.minutesUntilRain = minutesUntilRain;
        gridLog.precipChance = rainStart.precipitationChance;
        gridLog.precipIntensity = rainStart.precipitationIntensity;

        // Notify each device in this grid if rain is within their lead time
        for (const device of grid.devices) {
          if (minutesUntilRain <= device.leadTimeMinutes && minutesUntilRain >= -5) {
            // Check if we already notified recently (stored in KV metadata)
            const metaKey = `notified:${device.token}`;
            const lastNotified = await env.DEVICES.get(metaKey);
            if (lastNotified) {
              const elapsed = now - parseInt(lastNotified);
              if (elapsed < 30 * 60 * 1000) continue; // Skip if notified within 30 min
            }

            try {
              await sendRainAlert(device.token, minutesUntilRain, env);
              await env.DEVICES.put(metaKey, now.toString(), { expirationTtl: 3600 });
              gridLog.notificationsSent.push(device.token.substring(0, 8));
              console.log(`[Cron] Notified device in grid ${grid.gridKey}, rain in ${minutesUntilRain}m`);
            } catch (err) {
              console.error(`[Cron] Failed to notify device: ${err}`);
            }
          }
        }
      } catch (err) {
        gridLog.forecastResult = 'error';
        gridLog.error = String(err);
        console.error(`[Cron] Failed to fetch weather for grid ${grid.gridKey}: ${err}`);
      }
      cronLog.gridResults.push(gridLog);
    });

    await Promise.all(promises);

    // Write the log entry to KV, keep last 50 runs
    try {
      const logIndex: string[] = JSON.parse(await env.DEVICES.get('log:index') || '[]');
      const logKey = `log:${now}`;
      logIndex.push(logKey);
      // Trim to last 50
      const toDelete = logIndex.splice(0, Math.max(0, logIndex.length - 50));
      await Promise.all([
        env.DEVICES.put(logKey, JSON.stringify(cronLog), { expirationTtl: 86400 * 3 }),
        env.DEVICES.put('log:index', JSON.stringify(logIndex)),
        ...toDelete.map((k) => env.DEVICES.delete(k)),
      ]);
    } catch (err) {
      console.error(`[Cron] Failed to write log: ${err}`);
    }
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

async function handleDebugStatus(tokenPrefix: string, env: Env): Promise<Response> {
  // Find the device by token prefix
  let matchedDevice: DeviceRegistration | null = null;
  let cursor: string | undefined;
  do {
    const list = await env.DEVICES.list({ prefix: 'device:', cursor });
    for (const key of list.keys) {
      // key.name is "device:<full_token>"
      const token = key.name.substring('device:'.length);
      if (token.startsWith(tokenPrefix)) {
        matchedDevice = await env.DEVICES.get(key.name, 'json') as DeviceRegistration;
        break;
      }
    }
    if (matchedDevice) break;
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  if (!matchedDevice) {
    return new Response(JSON.stringify({ error: 'No device found matching that token prefix' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Get last notification time
  const notifiedRaw = await env.DEVICES.get(`notified:${matchedDevice.token}`);
  const lastNotified = notifiedRaw ? new Date(parseInt(notifiedRaw)).toISOString() : null;

  return new Response(JSON.stringify({
    device: {
      tokenPrefix: matchedDevice.token.substring(0, 8),
      lat: matchedDevice.lat,
      lon: matchedDevice.lon,
      gridKey: toGridKey(matchedDevice.lat, matchedDevice.lon),
      leadTimeMinutes: matchedDevice.leadTimeMinutes,
      registeredAt: matchedDevice.registeredAt,
    },
    lastNotified,
  }, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleDebugLogs(env: Env): Promise<Response> {
  const logIndex: string[] = JSON.parse(await env.DEVICES.get('log:index') || '[]');

  // Fetch the last 10 log entries
  const recentKeys = logIndex.slice(-10);
  const logs = await Promise.all(
    recentKeys.map(async (key) => {
      const raw = await env.DEVICES.get(key);
      return raw ? JSON.parse(raw) as CronLogEntry : null;
    })
  );

  return new Response(JSON.stringify(logs.filter(Boolean).reverse(), null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleRegister(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { token?: string; lat?: number; lon?: number; leadTimeMinutes?: number };

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
