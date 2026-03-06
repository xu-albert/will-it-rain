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
}

export interface GridCell {
  gridKey: string;
  devices: DeviceRegistration[];
}

export interface GridLogEntry {
  gridKey: string;
  lat: number;
  lon: number;
  deviceCount: number;
  deviceTokenPrefixes: string[];
  forecastResult: 'clear' | 'rain' | 'no_data' | 'error';
  minutesUntilRain?: number;
  precipChance?: number;
  precipIntensity?: number;
  notificationsSent: string[];
  error?: string;
}

export interface CronLogEntry {
  timestamp: string;
  gridResults: GridLogEntry[];
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
