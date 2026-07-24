import { Env } from './types';

// Generate JWT for APNs authentication (same key as WeatherKit but different use)
async function generateAPNsJWT(env: Env): Promise<string> {
  const header = { alg: 'ES256', kid: env.APPLE_KEY_ID };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: env.APPLE_TEAM_ID, iat: now };

  const b64url = (buf: ArrayBuffer) =>
    btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

  const headerB64 = btoa(JSON.stringify(header)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const payloadB64 = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const signingInput = `${headerB64}.${payloadB64}`;

  const pem = env.APPLE_PRIVATE_KEY.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s|\\n/g, '');
  const keyData = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));

  const key = await crypto.subtle.importKey('pkcs8', keyData, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput));

  return `${signingInput}.${b64url(signature)}`;
}

export type Intensity = 'light' | 'moderate' | 'heavy';

export function intensityFromMmPerHr(mmPerHr: number): Intensity {
  if (mmPerHr < 2.5) return 'light';
  if (mmPerHr < 7.5) return 'moderate';
  return 'heavy';
}

export async function sendRainAlert(
  deviceToken: string,
  minutesUntilRain: number,
  env: Env,
  intensity: Intensity = 'light'
): Promise<void> {
  const rain = intensity === 'light' ? 'Rain' : `${intensity[0].toUpperCase()}${intensity.slice(1)} rain`;
  const advice =
    intensity === 'heavy' ? ' Plan for a downpour.' : intensity === 'moderate' ? ' Bring a jacket.' : ' Grab an umbrella.';

  let title: string;
  let body: string;
  if (minutesUntilRain <= 0) {
    title = 'Rain starting now';
    body = `${rain} is beginning in your area.${advice}`;
  } else if (minutesUntilRain <= 5) {
    title = 'Rain in a few minutes';
    body = `${rain} starts in the next few minutes.${advice}`;
  } else {
    title = `Rain in ~${minutesUntilRain} min`;
    body = `${rain} expected in about ${minutesUntilRain} minutes.${advice}`;
  }
  await sendNotification(deviceToken, { title, body }, 1, env);
}

export async function sendRainEndAlert(
  deviceToken: string,
  env: Env,
  minutesUntilEnd = 0
): Promise<void> {
  const body =
    minutesUntilEnd <= 5
      ? 'The rain should ease off in the next few minutes.'
      : `The rain should ease off in about ${minutesUntilEnd} minutes.`;
  await sendNotification(deviceToken, { title: 'Rain ending soon', body }, 0, env);
}

async function sendNotification(
  deviceToken: string,
  alert: { title: string; body: string },
  badge: number,
  env: Env
): Promise<void> {
  const token = await generateAPNsJWT(env);

  const host = env.APNS_ENV === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
  const resp = await fetch(`https://${host}/3/device/${deviceToken}`, {
    method: 'POST',
    headers: {
      Authorization: `bearer ${token}`,
      'apns-topic': env.APNS_TOPIC,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      aps: { alert, badge, sound: 'default' },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`APNs error ${resp.status}: ${text}`);
  }
}
