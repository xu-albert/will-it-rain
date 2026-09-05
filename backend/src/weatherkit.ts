import { Env, WeatherKitForecast } from './types';

// Generate JWT for WeatherKit REST API authentication
async function generateJWT(env: Env): Promise<string> {
  const header = { alg: 'ES256', kid: env.APPLE_KEY_ID, id: `${env.APPLE_TEAM_ID}.${env.WEATHERKIT_SERVICE_ID}` };
  const now = Math.floor(Date.now() / 1000);
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
  const sig = b64url(signature);

  return `${signingInput}.${sig}`;
}

export async function fetchForecast(lat: number, lon: number, env: Env): Promise<WeatherKitForecast> {
  const token = await generateJWT(env);
  // forecastHourly is the fallback for regions with no forecastNextHour
  // (nextHour.ts). Only the hours that can contain the next 60 minutes are
  // asked for: the dataset starts on the current hour by default, and cutting
  // it off two hours out keeps the response near its old size. Still one
  // external subrequest.
  const hourlyEnd = new Date(Date.now() + 2 * 3_600_000).toISOString();
  const url =
    `https://weatherkit.apple.com/api/v1/weather/en-US/${lat}/${lon}` +
    `?dataSets=forecastNextHour,forecastHourly&hourlyEnd=${encodeURIComponent(hourlyEnd)}`;

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    throw new Error(`WeatherKit API error: ${resp.status} ${await resp.text()}`);
  }

  return resp.json() as Promise<WeatherKitForecast>;
}
