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

export interface WeatherKitForecast {
  forecastNextHour?: {
    minutes: Array<{
      startDate: string;
      precipitationChance: number;
      precipitationIntensity: number;
    }>;
  };
}
