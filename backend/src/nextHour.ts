import { WeatherKitForecast, WeatherKitMinute } from './types';

/** How many synthesized minutes ahead of `now` to hand back: the length of a real forecastNextHour. */
export const SYNTHESIZED_MINUTES = 60;

/**
 * How far before `now` the synthesized series begins: one cron interval
 * (`*\/10 * * * *` in wrangler.toml). The real minute feed is stamped a few
 * minutes before the tick reads it, and the cron leans on that lag — the first
 * dry minute after a wet one has to still be in the series at the tick that
 * follows it, or the terminal "Rain ended" Live Activity update is never sent.
 * A series starting exactly at `now` loses a wet-to-dry hour boundary the
 * moment it passes.
 */
export const SYNTHESIZED_LOOKBACK_MINUTES = 10;

/**
 * The next hour's minute series for a forecast, from whichever dataset has it.
 *
 * WeatherKit's forecastNextHour is regional. Where it is absent the cron used to
 * return early, which for every device outside minute coverage meant no rain
 * alert, ever — the same coverage hole the app had (edge-case report, finding
 * 10). Here that case falls back to the hourly forecast: each minute from
 * SYNTHESIZED_LOOKBACK_MINUTES before `now` to SYNTHESIZED_MINUTES after it
 * takes the chance and intensity of the hourly reading that contains it, so the
 * tick's minute-based arithmetic runs unchanged, just coarsely. An hourly
 * reading stands for the hour it starts; minutes no reading contains are left
 * out, so a response that begins on the current hour still covers from there.
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
  for (let i = -SYNTHESIZED_LOOKBACK_MINUTES; i < SYNTHESIZED_MINUTES; i += 1) {
    const t = now + i * 60_000;
    let containing = -1;
    for (let j = 0; j < hours.length; j += 1) {
      if (starts[j] <= t && t < starts[j] + 3_600_000) containing = j;
    }
    if (containing < 0) continue;
    synthesized.push({
      startTime: new Date(t).toISOString(),
      precipitationChance: hours[containing].precipitationChance,
      precipitationIntensity: hours[containing].precipitationIntensity,
    });
  }
  return synthesized.length > 0 ? synthesized : undefined;
}
