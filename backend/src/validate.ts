// Input validation for the public HTTP API.
//
// Every endpoint here is reachable by anyone: the Worker URL is hardcoded in the
// shipping iOS binary, so it is trivially extractable. The cron loop makes one
// WeatherKit call per distinct grid cell, which means unvalidated registrations
// are a direct lever on a 500k/month quota — a few thousand junk coordinates
// would drain it. These validators are the gate.

const HEX_ONLY = /^[0-9a-f]+$/i;

// Every APNs device token in production today is 32 bytes (64 hex chars), but
// Apple has explicitly reserved the right to change that, so allow headroom
// rather than pinning the exact size. This one is strict-ish because the device
// token becomes part of a KV key.
const MIN_TOKEN_LENGTH = 64;
const MAX_DEVICE_TOKEN_LENGTH = 128;

// ActivityKit push tokens are a different, longer format than device tokens and
// Apple documents no fixed size. This value is only ever stored inside a record,
// never used as a key, so the bound exists purely to cap junk — keep it loose
// enough that a legitimate token can never be turned away.
const MAX_ACTIVITY_TOKEN_LENGTH = 512;

function isHexTokenWithin(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length >= MIN_TOKEN_LENGTH &&
    value.length <= maxLength &&
    HEX_ONLY.test(value)
  );
}

export function isValidDeviceToken(value: unknown): value is string {
  return isHexTokenWithin(value, MAX_DEVICE_TOKEN_LENGTH);
}

export function isValidActivityToken(value: unknown): value is string {
  return isHexTokenWithin(value, MAX_ACTIVITY_TOKEN_LENGTH);
}

export function isValidLatitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isValidLongitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;
}

export const DEFAULT_LEAD_TIME_MINUTES = 20;
const MIN_LEAD_TIME_MINUTES = 5;
const MAX_LEAD_TIME_MINUTES = 120;

// Lead time only ever comes from a fixed set of picker values in the app, so
// anything outside the sane range is either a bug or an attempt to widen the
// notification window. Clamp instead of rejecting: a bad lead time shouldn't
// cost a user their registration.
export function clampLeadTimeMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LEAD_TIME_MINUTES;
  return Math.min(MAX_LEAD_TIME_MINUTES, Math.max(MIN_LEAD_TIME_MINUTES, Math.round(value)));
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// Compares in time independent of how many characters match, so a caller can't
// discover the admin token one byte at a time by timing responses.
export function secureEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
