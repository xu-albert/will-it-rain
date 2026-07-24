export interface Env {
  DEVICES: KVNamespace;
  APPLE_TEAM_ID: string;
  APPLE_KEY_ID: string;
  APPLE_PRIVATE_KEY: string;
  WEATHERKIT_SERVICE_ID: string;
  APNS_TOPIC: string;
  APNS_ENV: string; // "sandbox" or "production"
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
