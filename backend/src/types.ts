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
    // Per-period rollup carrying the precipitation *type* ("clear", "rain",
    // "snow", "sleet", "hail", "mixed"). The per-minute entries only carry
    // chance and intensity, so this is the only place the type appears in the
    // forecastNextHour dataset — and it costs no extra quota, since the Worker
    // already requests that dataset. Optional throughout: treated as absent
    // rather than trusted, so a schema change degrades to rain, never throws.
    summary?: Array<{
      startTime?: string;
      condition?: string;
      precipitationChance?: number;
      precipitationIntensity?: number;
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

// Mirrors the widget's `RainActivityAttributes.Precip`.
export type Precip = 'rain' | 'wintry';

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
  // Rain vs wintry styling. Must be sent on every push: content-state is a
  // full replacement, not a merge, so omitting it would decode as nil on the
  // widget and revert a snowing card to rain visuals on the next cron tick.
  precip: Precip;
}
