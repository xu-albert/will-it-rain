import { Env, WeatherKitForecast } from './types';
import { SYNTHESIZED_LOOKBACK_MINUTES } from './nextHour';
import { toGridKey } from './grid';
import { formatError, isTimeoutError, logError, scrubSensitive } from './logger';

// WeatherKit accepts tokens for up to one hour; refresh a little earlier so a
// cron burst never signs one token per grid cell.
let cachedWeatherKitJWT: { token: string; iat: number } | null = null;

// Generate JWT for WeatherKit REST API authentication
async function generateJWT(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedWeatherKitJWT && now - cachedWeatherKitJWT.iat < 40 * 60) {
    return cachedWeatherKitJWT.token;
  }

  const header = { alg: 'ES256', kid: env.APPLE_KEY_ID, id: `${env.APPLE_TEAM_ID}.${env.WEATHERKIT_SERVICE_ID}` };
  const payload = {
    iss: env.APPLE_TEAM_ID,
    iat: now,
    exp: now + 3600,
    sub: env.WEATHERKIT_SERVICE_ID,
  };

  const enc = new TextEncoder();
  const b64url = (buf: ArrayBuffer) =>
    btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

  const headerB64 = btoa(JSON.stringify(header)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const payloadB64 = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const signingInput = `${headerB64}.${payloadB64}`;

  // Import the private key (PEM PKCS#8)
  const pem = env.APPLE_PRIVATE_KEY.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s|\\n/g, '');
  const keyData = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));

  const key = await crypto.subtle.importKey('pkcs8', keyData, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signingInput));

  // Convert DER signature to raw r||s format for ES256
  const token = `${signingInput}.${b64url(signature)}`;
  cachedWeatherKitJWT = { token, iat: now };

  return token;
}

// Bound upstream stalls so one hung WeatherKit socket cannot stall the sequential cron tick.
export const WEATHERKIT_TIMEOUT_MS = 8_000;

export class WeatherKitError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string
  ) {
    super(`WeatherKit API error: ${status} ${detail}`);
    this.name = 'WeatherKitError';
  }
}

export async function fetchForecast(
  lat: number,
  lon: number,
  env: Env,
  gridKey: string = toGridKey(lat, lon)
): Promise<WeatherKitForecast> {
  // forecastHourly is the fallback for regions with no forecastNextHour
  // (nextHour.ts). Only the hours that can contain its synthesized minutes are
  // asked for: from the hour containing the series' lookback start — by default
  // the dataset begins on the current hour, which would leave the lookback
  // uncovered right after an hour boundary — to two hours out, which keeps the
  // response near its old size. Still one external subrequest.
  const now = Date.now();
  const lookbackStart = now - SYNTHESIZED_LOOKBACK_MINUTES * 60_000;
  const hourlyStart = new Date(lookbackStart - (lookbackStart % 3_600_000)).toISOString();
  const hourlyEnd = new Date(now + 2 * 3_600_000).toISOString();
  const url =
    `https://weatherkit.apple.com/api/v1/weather/en-US/${lat}/${lon}` +
    `?dataSets=forecastNextHour,forecastHourly` +
    `&hourlyStart=${encodeURIComponent(hourlyStart)}&hourlyEnd=${encodeURIComponent(hourlyEnd)}`;

  const startMs = Date.now();
  let status: number | undefined;
  try {
    const token = await generateJWT(env);
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(WEATHERKIT_TIMEOUT_MS),
    });
    status = resp.status;

    if (!resp.ok) {
      const body = await resp.text();
      const durationMs = Date.now() - startMs;
      const detail = scrubSensitive(body.slice(0, 200));
      logError('weatherkit.error', {
        gridKey,
        status: resp.status,
        durationMs,
        error: detail,
      });
      throw new WeatherKitError(resp.status, detail);
    }

    return (await resp.json()) as WeatherKitForecast;
  } catch (err) {
    if (err instanceof WeatherKitError) throw err;
    const durationMs = Date.now() - startMs;
    if (isTimeoutError(err)) {
      logError('weatherkit.timeout', {
        gridKey,
        status,
        timeoutMs: WEATHERKIT_TIMEOUT_MS,
        durationMs,
        error: formatError(err),
      });
    } else {
      logError('weatherkit.error', {
        gridKey,
        status,
        durationMs,
        error: formatError(err),
      });
    }
    throw err;
  }
}
