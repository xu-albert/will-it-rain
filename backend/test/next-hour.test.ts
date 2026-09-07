// The minute series the cron reasons over, where WeatherKit has one and where
// it has to be synthesized from the hourly forecast instead.

import { describe, expect, it } from 'vitest';
import { nextHourMinutes, SYNTHESIZED_LOOKBACK_MINUTES, SYNTHESIZED_MINUTES } from '../src/nextHour';

const HOUR = 3_600_000;
/** A fixed top-of-hour instant. */
const hour0 = Date.UTC(2026, 8, 4, 22, 0, 0);
const hour = (h: number) => hour0 + h * HOUR;
const minute = (m: number, from = hour0) => from + m * 60_000;
/** Index into a synthesized series taken at `now` of the minute at `at`. */
const indexOf = (at: number, now: number) => (at - now) / 60_000 + SYNTHESIZED_LOOKBACK_MINUTES;
const fullLength = SYNTHESIZED_LOOKBACK_MINUTES + SYNTHESIZED_MINUTES;

function hourly(wet: number[] = [], hours = [-1, 0, 1, 2]) {
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

  it('synthesizes the series from the hourly readings that contain each minute', () => {
    // 22:05, hour 22 dry, hour 23 wet: every minute up to 23:00 dry, wet from there.
    const now = minute(5);
    const minutes = nextHourMinutes({ forecastHourly: hourly([1]) }, now);
    const wetFrom = indexOf(hour(1), now);
    expect(minutes).toHaveLength(fullLength);
    expect(minutes!.slice(0, wetFrom).every((m) => m.precipitationIntensity === 0)).toBe(true);
    expect(minutes!.slice(wetFrom).every((m) => m.precipitationChance === 0.8 && m.precipitationIntensity === 2)).toBe(true);
    expect(minutes![wetFrom].startTime).toBe(new Date(hour(1)).toISOString());
  });

  it('begins one cron interval before now, so an hour boundary just passed is still in the series', () => {
    // The real feed's first minute lags the tick by a few minutes, and the cron
    // relies on that to see a wet minute ahead of the first dry one at the tick
    // after the rain ends. Hour 21 wet, hour 22 dry, read at 22:05: the series
    // opens on the last wet minutes of hour 21 and turns dry on the hour.
    const now = minute(5);
    const minutes = nextHourMinutes({ forecastHourly: hourly([-1]) }, now);
    expect(minutes![0].startTime).toBe(new Date(now - SYNTHESIZED_LOOKBACK_MINUTES * 60_000).toISOString());
    expect(minutes![0].precipitationIntensity).toBe(2);
    expect(minutes!.findIndex((m) => m.precipitationIntensity === 0)).toBe(indexOf(hour(0), now));
    expect(minutes![indexOf(hour(0), now)].startTime).toBe(new Date(hour(0)).toISOString());

    // Read exactly on the hour the whole lookback is the wet hour.
    const onTheHour = nextHourMinutes({ forecastHourly: hourly([-1]) }, hour(0));
    expect(onTheHour!.findIndex((m) => m.precipitationIntensity === 0)).toBe(SYNTHESIZED_LOOKBACK_MINUTES);
  });

  it('covers from the first reading when the hourly readings begin after the lookback', () => {
    // A response that starts on the current hour leaves the lookback minutes
    // before it uncovered; the series starts where the readings do rather
    // than being abandoned.
    const now = minute(5);
    const minutes = nextHourMinutes({ forecastHourly: hourly([], [0, 1, 2]) }, now);
    expect(minutes![0].startTime).toBe(new Date(hour(0)).toISOString());
    expect(minutes).toHaveLength(fullLength - 5);
  });

  it('stops where the hourly readings run out', () => {
    const minutes = nextHourMinutes({ forecastHourly: hourly([], [0]) }, minute(20));
    expect(minutes).toHaveLength(SYNTHESIZED_LOOKBACK_MINUTES + SYNTHESIZED_MINUTES - 20);
  });

  it('is undefined when neither dataset covers the next hour', () => {
    expect(nextHourMinutes({}, minute(5))).toBeUndefined();
    expect(nextHourMinutes({ forecastNextHour: { minutes: [] } }, minute(5))).toBeUndefined();
    expect(nextHourMinutes({ forecastHourly: { hours: [] } }, minute(5))).toBeUndefined();
    // Hourly readings that all start after the next hour cover nothing of it.
    expect(nextHourMinutes({ forecastHourly: hourly([], [3, 4]) }, minute(5))).toBeUndefined();
  });

  it('is unmoved by the order the hourly readings arrive in', () => {
    const now = minute(5);
    const reversed = { hours: hourly([1]).hours.reverse() };
    const minutes = nextHourMinutes({ forecastHourly: reversed }, now);
    expect(minutes![indexOf(hour(1), now) - 1].precipitationIntensity).toBe(0);
    expect(minutes![indexOf(hour(1), now)].precipitationIntensity).toBe(2);
  });
});
