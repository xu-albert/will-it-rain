// Zero-dependency structured JSON logger for the Cloudflare Worker.
//
// Emits single-line JSON to console.log / console.warn / console.error so
// Cloudflare Workers Logs and `wrangler tail --format json` can index and
// filter by event, level, route, status, code, gridKey, and durationMs.
//
// Privacy invariant: raw APNs device tokens, Live Activity push tokens, admin
// tokens, raw client IPs, and exact lat/lon coordinates must NEVER appear in
// logs. Callers pass coarse `gridKey` and hashed `bucketPrefix` only, and this
// module enforces a defensive redaction pass over every emitted payload.

export type LogLevel = 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

const FORBIDDEN_KEYS = new Set([
  'token',
  'devicetoken',
  'activitytoken',
  'admintoken',
  'ip',
  'clientip',
  'lat',
  'lon',
  'latitude',
  'longitude',
  'authorization',
  'privatekey',
]);

const LONG_HEX_TOKEN_RE = /\b[0-9a-fA-F]{64,}\b/g;
const APNS_DEVICE_PATH_RE = /\/3\/device\/[^\s"'/?]+/g;
const BEARER_JWT_RE = /\bBearer\s+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/gi;
const WEATHERKIT_COORDS_RE = /\/weather\/[^/\s]+\/-?\d+(?:\.\d+)?\/-?\d+(?:\.\d+)?/g;

// Fields whose string values are known-safe structural identifiers (coarse grid
// key, route path, timestamp, event name, etc.) and should not be altered.
const PASSTHROUGH_KEYS = new Set([
  'event',
  'level',
  'ts',
  'route',
  'method',
  'code',
  'gridKey',
  'bucketPrefix',
  'shard',
  'object',
  'op',
  'prefix',
  'keyPrefix',
  'pushType',
  'activityEvent',
  'env',
  'precip',
  'kind',
]);

/** Scrubs tokens, JWTs, and raw coordinate URLs from free-form text. */
export function scrubSensitive(value: string): string {
  return value
    .replace(APNS_DEVICE_PATH_RE, '/3/device/[redacted]')
    .replace(BEARER_JWT_RE, 'Bearer [redacted]')
    .replace(WEATHERKIT_COORDS_RE, '/weather/[redacted]')
    .replace(LONG_HEX_TOKEN_RE, '[redacted-token]');
}

/** Formats an unknown error into a concise, token-scrubbed string. */
export function formatError(err: unknown): string {
  if (err instanceof Error) {
    const base = err.name && err.name !== 'Error' ? `${err.name}: ${err.message}` : err.message;
    return scrubSensitive(base || err.name || 'Error');
  }
  return scrubSensitive(String(err));
}

/** Detects AbortSignal.timeout / AbortController timeouts across Node and workerd. */
export function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = 'name' in err ? String((err as { name?: unknown }).name) : '';
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  const message = 'message' in err ? String((err as { message?: unknown }).message) : '';
  return /timed out|timeout|aborted due to timeout/i.test(message);
}

function sanitizeValue(key: string, value: unknown): unknown {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    return PASSTHROUGH_KEYS.has(key) ? value : scrubSensitive(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? scrubSensitive(item) : item));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined || FORBIDDEN_KEYS.has(k.toLowerCase())) continue;
      out[k] = sanitizeValue(k, v);
    }
    return out;
  }
  return value;
}

function emit(level: LogLevel, event: string, fields?: LogFields): void {
  const record: Record<string, unknown> = {
    event,
    level,
    ts: new Date().toISOString(),
  };

  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      if (key === 'event' || key === 'level' || key === 'ts') continue;
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) continue;
      record[key] = sanitizeValue(key, value);
    }
  }

  const line = JSON.stringify(record);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function logInfo(event: string, fields?: LogFields): void {
  emit('info', event, fields);
}

export function logWarn(event: string, fields?: LogFields): void {
  emit('warn', event, fields);
}

export function logError(event: string, fields?: LogFields): void {
  emit('error', event, fields);
}
