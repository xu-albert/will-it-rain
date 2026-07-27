import { Env, LiveActivityContentState } from './types';

// Generate JWT for APNs authentication (same key as WeatherKit but different use)
// APNs provider tokens may be reused for up to 1 hour; regenerating one per push
// trips APNs "TooManyProviderTokenUpdates" (429). Cache and refresh every ~40 min.
let cachedAPNsJWT: { token: string; iat: number } | null = null;

async function generateAPNsJWT(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedAPNsJWT && now - cachedAPNsJWT.iat < 40 * 60) {
    return cachedAPNsJWT.token;
  }
  const header = { alg: 'ES256', kid: env.APPLE_KEY_ID };
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

  const token = `${signingInput}.${b64url(signature)}`;
  cachedAPNsJWT = { token, iat: now };
  return token;
}

// APNs rejections carry a machine-readable `reason` that decides whether the
// token is worth keeping. Callers need the status and reason to tell "this
// device is gone" apart from "APNs is having a bad day", so surface both
// instead of collapsing them into a string.
export class APNsError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string
  ) {
    super(`APNs error ${status}: ${reason}`);
    this.name = 'APNsError';
  }

  // 410 is APNs telling us definitively that the token is no longer valid.
  get isUnregistered(): boolean {
    return this.status === 410 || this.reason.includes('Unregistered');
  }

  // BadDeviceToken is ambiguous: it's what a genuinely dead token returns, but
  // also what *every* token returns if APNS_ENV points at the wrong APNs host.
  // Callers must not treat a single occurrence as proof the device is gone.
  get isBadDeviceToken(): boolean {
    return this.reason.includes('BadDeviceToken');
  }
}

function parseAPNsReason(body: string): string {
  try {
    const parsed = JSON.parse(body) as { reason?: string };
    return parsed.reason ?? body;
  } catch {
    return body;
  }
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

  let title: string;
  let body: string;
  if (minutesUntilRain <= 0) {
    title = 'Rain starting now';
    body = `${rain} is beginning in your area.`;
  } else if (minutesUntilRain <= 5) {
    title = 'Rain in a few minutes';
    body = `${rain} starts in the next few minutes.`;
  } else {
    title = `Rain in ~${minutesUntilRain} min`;
    body = `${rain} expected in about ${minutesUntilRain} minutes.`;
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
      ? 'The rain should stop in the next few minutes.'
      : `The rain should stop in about ${minutesUntilEnd} minutes.`;
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
    throw new APNsError(resp.status, parseAPNsReason(await resp.text()));
  }
}

// ActivityKit decodes a Live Activity push's "content-state" with a default
// JSONDecoder, whose date strategy is `.deferredToDate` — NOT Unix epoch seconds.
// Foundation's reference date is 2001-01-01T00:00:00Z, which is 978307200 seconds
// after the Unix epoch. Any `Date?` field inside content-state (e.g. countdownTarget)
// must be encoded as seconds-since-2001, or ActivityKit will fail to decode the push.
// (The outer `aps` fields — timestamp/stale-date/dismissal-date — are unrelated to
// content-state and use ordinary Unix epoch seconds, per Apple's APNs docs.)
const APPLE_REFERENCE_DATE_OFFSET_SECONDS = 978307200;

export function encodeActivityDate(date: Date): number {
  return date.getTime() / 1000 - APPLE_REFERENCE_DATE_OFFSET_SECONDS;
}

export type LiveActivityEvent = 'update' | 'end';

export async function sendLiveActivityUpdate(
  activityToken: string,
  contentState: LiveActivityContentState,
  env: Env,
  event: LiveActivityEvent = 'update'
): Promise<void> {
  const token = await generateAPNsJWT(env);

  const host = env.APNS_ENV === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
  const nowSeconds = Math.floor(Date.now() / 1000);

  const aps: Record<string, unknown> = {
    timestamp: nowSeconds,
    event,
    'content-state': contentState,
    'stale-date': nowSeconds + 45 * 60,
  };
  if (event === 'end') {
    aps['dismissal-date'] = nowSeconds + 5 * 60;
  }

  const resp = await fetch(`https://${host}/3/device/${activityToken}`, {
    method: 'POST',
    headers: {
      Authorization: `bearer ${token}`,
      'apns-topic': `${env.APNS_TOPIC}.push-type.liveactivity`,
      'apns-push-type': 'liveactivity',
      'apns-priority': '10',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ aps }),
  });

  if (!resp.ok) {
    throw new APNsError(resp.status, parseAPNsReason(await resp.text()));
  }
}
