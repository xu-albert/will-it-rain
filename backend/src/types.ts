export interface Env {
  DEVICES: KVNamespace;
  /** Per-client registration throttle. One instance per hashed client address. */
  REGISTRATION_LIMITER: DurableObjectNamespace;
  /** The authoritative grid-cell / per-cell-device tally. One global instance. */
  COVERAGE: DurableObjectNamespace;
  APPLE_TEAM_ID: string;
  APPLE_KEY_ID: string;
  APPLE_PRIVATE_KEY: string;
  WEATHERKIT_SERVICE_ID: string;
  APNS_TOPIC: string;
  APNS_ENV: string; // "sandbox" or "production"
  ADMIN_TOKEN?: string; // secret gating /test-rain and /test-cron
}

export interface DeviceRegistration {
  token: string;
  lat: number;
  lon: number;
  leadTimeMinutes: number;
  /** First-seen time. Never restamped — selectCellsWithinCap ranks on it. */
  registeredAt: string;
  /** Last time this record was actually written, i.e. when its TTL was last reset. */
  renewedAt?: string;
  rainStartEnabled?: boolean;
  rainEndEnabled?: boolean;
}

/**
 * A device's Live Activity push token, stored under its own `activity:` key.
 *
 * Deliberately not a field on DeviceRegistration. `/register` and
 * `/register-activity` both write within seconds of each other in one
 * ContentView.fetchWeather cycle, and KV serves reads from a colo-local cache
 * with a 60-second floor — so `/register`'s read-modify-write could see a
 * pre-activity copy of the record and write the token back out of existence.
 * Separate keys mean the two writers never touch the same value, which closes
 * that race by construction rather than by racing it.
 */
export interface ActivityRegistration {
  activityToken: string;
  activityUpdatedAt: string;
}

/** Metadata stored alongside an `activity:` key, so one list call yields every token. */
export interface ActivityKeyMetadata {
  activityToken: string;
}

export interface GridCell {
  gridKey: string;
  devices: DeviceRegistration[];
}

/** Grid key -> the device tokens registered in it. The CoverageRegistry's whole state. */
export type CoverageMap = Record<string, string[]>;

export interface RateReply {
  ok: boolean;
  /** Seconds until the caller's window rolls over. Only meaningful when !ok. */
  retryAfterSeconds: number;
}

export interface CoverageReply {
  ok: boolean;
  /** Which cap was hit. Only present when !ok. */
  code?: 'coverage_at_capacity' | 'cell_at_capacity';
  /** Distinct cells currently covered. */
  cells: number;
  /** Devices in the requested cell. */
  devices: number;
}

export interface WeatherKitMinute {
  startTime: string;
  precipitationChance: number;
  precipitationIntensity: number;
}

export interface WeatherKitForecast {
  /** Minute-by-minute for about the next hour. Regional: absent outside coverage. */
  forecastNextHour?: {
    minutes: WeatherKitMinute[];
  };
  /**
   * Hourly readings, from the hour requested (see weatherkit.ts). Only the few
   * around now are asked for; they stand in for forecastNextHour where
   * WeatherKit has no minute forecast (see nextHour.ts).
   */
  forecastHourly?: {
    hours: Array<{
      forecastStart: string;
      precipitationChance: number;
      /** mm/h, the same unit as a minute's. */
      precipitationIntensity: number;
    }>;
  };
}

// Mirrors the iOS widget extension's `ContentState` (Codable, Hashable) exactly —
// field names/types must match, since this is JSON-encoded straight into the
// Live Activity push payload's "content-state".
export interface LiveActivitySegment {
  start: number; // 0...1, fraction of windowMinutes
  end: number; // 0...1, fraction of windowMinutes
}

export interface LiveActivityContentState {
  statusText: string;
  countdownTarget: number | null; // seconds since 2001-01-01 (see apns.ts encodeActivityDate)
  heroText: string | null;
  subBold: string;
  subRest: string;
  boldFirst: boolean;
  rightText: string;
  segments: LiveActivitySegment[];
  windowMinutes: number;
  midLabel: string;
  endLabel: string;
  flagText: string | null;
  flagPosition: number | null;
}
