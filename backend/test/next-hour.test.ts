// The minute series the cron reasons over, where WeatherKit has one and where
// it has to be synthesized from the hourly forecast instead.

import { describe, expect, it } from 'vitest';
import { nextHourMinutes, SYNTHESIZED_MINUTES } from '../src/nextHour';

const HOUR = 3_600_000;
/** A fixed top-of-hour instant. */
const hour0 = Date.UTC(2026, 8, 4, 22, 0, 0);
const hour = (h: number) => hour0 + h * HOUR;
const minute = (m: number, from = hour0) => from + m * 60_000;

function hourly(wet: number[] = [], hours = [0, 1, 2]) {
  return {
    hours: hours.map((h) => ({
      forecastStart: new Date(hour(h)).toISOString(),
      precipitationChance: wet.includes(h) ? 0.8 : 0,
      precipitationIntensity: wet.includes(h) ? 2 : 0,
    })),
  };
}

const realMinutes = Array.from({ length: 60 }, (_, i) => ({
  startTime: new Date(minute(i)).toISOString(),
  precipitationChance: 0.5,
  precipitationIntensity: 1,
}));

describe('nextHourMinutes', () => {
  it('hands back the real minute forecast untouched when there is one', () => {
    const minutes = nextHourMinutes({ forecastNextHour: { minutes: realMinutes }, forecastHourly: hourly([0]) }, minute(5));
    expect(minutes).toBe(realMinutes);
  });

  it('synthesizes the next hour from the hourly readings that contain each minute', () => {
    // 22:05, hour 22 dry, hour 23 wet: minutes 0–54 dry, 55–59 wet.
    const minutes = nextHourMinutes({ forecastHourly: hourly([1]) }, minute(5));
    expect(minutes).toHaveLength(SYNTHESIZED_MINUTES);
    expect(minutes![0].startTime).toBe(new Date(minute(5)).toISOString());
    expect(minutes!.slice(0, 55).every((m) => m.precipitationIntensity === 0)).toBe(true);
    expect(minutes!.slice(55).every((m) => m.precipitationChance === 0.8 && m.precipitationIntensity === 2)).toBe(true);
    expect(minutes![55].startTime).toBe(new Date(hour(1)).toISOString());
  });

  it('treats a wet current hour as raining from the first minute', () => {
    const minutes = nextHourMinutes({ forecastHourly: hourly([0]) }, minute(5));
    expect(minutes![0].precipitationIntensity).toBe(2);
    expect(minutes!.findIndex((m) => m.precipitationIntensity === 0)).toBe(55);
  });

  it('stops where the hourly readings run out', () => {
    const minutes = nextHourMinutes({ forecastHourly: hourly([], [0]) }, minute(20));
    expect(minutes).toHaveLength(40);
  });

  it('is undefined when neither dataset covers the next hour', () => {
    expect(nextHourMinutes({}, minute(5))).toBeUndefined();
    expect(nextHourMinutes({ forecastNextHour: { minutes: [] } }, minute(5))).toBeUndefined();
    expect(nextHourMinutes({ forecastHourly: { hours: [] } }, minute(5))).toBeUndefined();
    // Hourly readings that all start after the next hour cover nothing of it.
    expect(nextHourMinutes({ forecastHourly: hourly([], [3, 4]) }, minute(5))).toBeUndefined();
  });

  it('is unmoved by the order the hourly readings arrive in', () => {
    const reversed = { hours: hourly([1]).hours.reverse() };
    const minutes = nextHourMinutes({ forecastHourly: reversed }, minute(5));
    expect(minutes![54].precipitationIntensity).toBe(0);
    expect(minutes![55].precipitationIntensity).toBe(2);
  });
});
