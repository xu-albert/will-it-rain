export interface Env {
  DEVICES: KVNamespace;
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
  registeredAt: string;
  rainStartEnabled?: boolean;
  rainEndEnabled?: boolean;
  activityToken?: string;
  activityUpdatedAt?: string;
}

export interface GridCell {
  gridKey: string;
  devices: DeviceRegistration[];
}

export interface WeatherKitForecast {
  forecastNextHour?: {
    minutes: Array<{
      startTime: string;
      precipitationChance: number;
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
