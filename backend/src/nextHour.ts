import { WeatherKitForecast, WeatherKitMinute } from './types';

/** How many synthesized minutes to hand back: the length of a real forecastNextHour. */
export const SYNTHESIZED_MINUTES = 60;

/**
 * The next hour's minute series for a forecast, from whichever dataset has it.
 *
 * WeatherKit's forecastNextHour is regional. Where it is absent the cron used to
 * return early, which for every device outside minute coverage meant no rain
 * alert, ever — the same coverage hole the app had (edge-case report, finding
 * 10). Here that case falls back to the hourly forecast: each of the next
 * SYNTHESIZED_MINUTES minutes from `now` takes the chance and intensity of the
 * hourly reading that contains it, so the tick's minute-based arithmetic runs
 * unchanged, just coarsely. An hourly reading stands for the hour it starts.
 *
 * Returns undefined when neither dataset covers the next hour, which the callers
 * treat exactly as they treated a missing forecastNextHour.
 */
export function nextHourMinutes(forecast: WeatherKitForecast, now: number): WeatherKitMinute[] | undefined {
  const minutes = forecast.forecastNextHour?.minutes;
  if (minutes && minutes.length > 0) return minutes;

  const hours = forecast.forecastHourly?.hours;
  if (!hours || hours.length === 0) return undefined;

  const starts = hours.map((h) => new Date(h.forecastStart).getTime());
  const synthesized: WeatherKitMinute[] = [];
  for (let i = 0; i < SYNTHESIZED_MINUTES; i += 1) {
    const t = now + i * 60_000;
    let containing = -1;
    for (let j = 0; j < hours.length; j += 1) {
      if (starts[j] <= t && t < starts[j] + 3_600_000) containing = j;
    }
    if (containing < 0) break;
    synthesized.push({
      startTime: new Date(t).toISOString(),
      precipitationChance: hours[containing].precipitationChance,
      precipitationIntensity: hours[containing].precipitationIntensity,
    });
  }
  return synthesized.length > 0 ? synthesized : undefined;
}
