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

  const pem = env.APPLE_PRIVATE_KEY.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n|\r/g, '');
  const keyData = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));

  const key = await crypto.subtle.importKey('pkcs8', keyData, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput));

  return `${signingInput}.${b64url(signature)}`;
}

export async function sendRainAlert(
  deviceToken: string,
  minutesUntilRain: number,
  env: Env
): Promise<void> {
  const body =
    minutesUntilRain <= 0
      ? 'Rain is starting now!'
      : minutesUntilRain <= 5
        ? 'Rain starting in the next few minutes'
        : `Rain expected in ~${minutesUntilRain} minutes`;

  await sendNotification(deviceToken, { title: 'Rain Incoming', body }, 1, env);
}

export async function sendRainEndAlert(deviceToken: string, env: Env): Promise<void> {
  await sendNotification(deviceToken, { title: 'Rain Ending', body: 'Rain is expected to stop soon' }, 0, env);
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
