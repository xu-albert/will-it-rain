import {
  ActivityKeyMetadata,
  ActivityRegistration,
  Env,
  DeviceRegistration,
  GridCell,
  LiveActivityContentState,
  Precip,
  SummaryPeriod,
  WeatherKitForecast,
} from './types';
import { LegacyRecord, readActivityTokens, readCoverage, gridCenter, toGridKey } from './grid';
import { fetchForecast } from './weatherkit';
import { formatError, isTimeoutError, logError, logInfo, logWarn } from './logger';
import { nextHourMinutes } from './nextHour';
import { CRON_PERIOD_MINUTES } from './scheduling';
import {
  APNsError,
  sendRainAlert,
  sendRainEndAlert,
  sendRainResumeAlert,
  sendLiveActivityUpdate,
  encodeActivityDate,
  intensityFromMmPerHr,
  LIVE_ACTIVITY_PRIORITY,
} from './apns';
import {
  asBoolean,
  clampLeadTimeMinutes,
  isValidLatitude,
  isValidLongitude,
  isValidActivityToken,
  isValidDeviceToken,
  isValidMinuteOfDay,
  isValidTimeZoneIdentifier,
  secureEquals,
} from './validate';
import {
  ACTIVITY_RECORD_TTL_SECONDS,
  DEVICE_RECORD_REFRESH_SECONDS,
  DEVICE_REWRITE_COOLDOWN_SECONDS,
  DEVICE_RECORD_TTL_SECONDS,
  DORMANT_CELL_THRESHOLD_SECONDS,
  MAX_DEVICES_PER_CELL,
  MAX_DEVICE_RECORDS,
  MAX_GRID_CELLS,
  MAX_TTL_MIGRATIONS_PER_TICK,
  PUSH_BUDGET_PER_INVOCATION,
  checkRegistrationRate,
  createPushBudget,
  createReapBudget,
  flagPendingReap,
  readPendingReaps,
  TickBudget,
  MAX_DEVICE_REAPS_PER_TICK,
  reconcileCoverage,
  releaseGridCell,
  reserveGridCell,
  selectCellsWithinCap,
} from './abuse';

// The Durable Objects that hold the gate's counters. Exported here because
// wrangler resolves class_name bindings against this module (see wrangler.toml).
export { RegistrationLimiter, CoverageRegistry } from './durable';

// Live Activity segment math is normalized over this window, matching the widget's ring.
const ACTIVITY_WINDOW_MINUTES = 90;

// How many BadDeviceToken rejections a device may collect before we drop it.
// See recordPushFailure for why this isn't 1.
const BAD_TOKEN_STRIKES = 5;

// How far past a forecast onset a rain-start alert is still worth sending. The
// merged minute/hourly series is stamped a few minutes behind the tick that
// reads it (see AGENTS.md), so the first wet minute can already be in the past.
const START_SLACK_MINUTES = 5;

// How far a forecast onset may move between two ticks and still be the same
// rain: one tick's gap, plus the slack by which the series lags the tick.
const SAME_ONSET_DRIFT_MINUTES = CRON_PERIOD_MINUTES + START_SLACK_MINUTES;

// However the forecast moves, a device gets at most one alert of a kind this
// often. A nowcast onset that oscillates near the far end of the alert window
// is a different onset each time it moves, and without this floor that is a
// push every tick.
const ALERT_FLOOR_MINUTES = 30;

// Shared with PrecipitationPeriod.detect on iOS. WeatherKit reports intensity
// in mm/h on both APIs; the boundaries are deliberately inclusive.
const LIKELY_RAIN_PROBABILITY = 0.5;
const MINIMUM_WET_MM_PER_HOUR = 0.1;
export const isWet = (m: { precipitationChance: number; precipitationIntensity: number }) =>
  m.precipitationIntensity >= MINIMUM_WET_MM_PER_HOUR ||
  m.precipitationChance >= LIKELY_RAIN_PROBABILITY;

/** Whether ordinary alerts are currently silenced in the device's local time. */
export function isInQuietHours(device: DeviceRegistration, at: Date): boolean {
  if (device.quietHoursEnabled !== true) return false;
  const start = device.quietHoursStartMinutes;
  const end = device.quietHoursEndMinutes;
  const timeZone = device.timeZoneIdentifier;
  if (start === undefined || end === undefined || timeZone === undefined) return true;

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(at);
  } catch {
    return true;
  }
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return true;
  const localMinutes = hour * 60 + minute;
  if (start <= end) return localMinutes >= start && localMinutes < end;
  return localMinutes >= start || localMinutes < end;
}

// WeatherKit condition strings that should render with the wintry treatment.
// The WeatherKit REST API documents forecastHourly.summary[].condition as
// its PrecipitationType enum: clear, precipitation, rain, snow, sleet, hail,
// mixed — lowercase bare nouns, confirmed live. This is an exact match on the
// four with ice in them; everything else, documented or not, is rain.
const WINTRY_CONDITIONS = new Set(['snow', 'sleet', 'hail', 'mixed']);

// Server-side copy, kept in step with `precip`. Without this the widget would
// draw a snowflake next to the word "rain".
function copyFor(precip: Precip) {
  const wintry = precip === 'wintry';
  return {
    incoming: wintry ? 'Snow incoming' : 'Rain incoming',
    expected: wintry ? 'Snow expected' : 'Rain expected',
    fallingNow: wintry ? 'Snowing now' : 'Raining now',
    fallingVerb: wintry ? 'Snowing · ' : 'Raining · ',
    fallingHero: wintry ? 'Snowing' : 'Raining',
    ended: wintry ? 'Snow ended' : 'Rain ended',
    hasStopped: wintry ? 'Snow has stopped' : 'Rain has stopped',
  };
}

// Reads the precipitation type out of forecastNextHour's summary rollup for
// the moment a push is about.
//
// The per-minute entries carry only chance and intensity, so the summary is the
// sole source of type in this dataset. Every field is treated as possibly
// absent: if Apple changes the schema, or the summary contains only "clear",
// this returns 'rain' — both the old behaviour and the right default for a rain
// app. It never throws.
//
// `at` is the start of the minute the push describes — the first wet minute on
// the rain-start path — and resolves to the first non-clear period from the
// one covering it onward, so "snow starting in 40 min" is wintry even though
// it is clear now. Reading past a clear covering period matters because
// Apple's summary applies a higher confidence bar than the per-minute test
// (the spec's Belfast case): on a gradual onset the first wet minute lands a
// little before the summary's snow period begins. Without `at` the answer is
// what is falling now, the first period: that is the rain-end path, and it
// must not read a later period, or light rain now with snow later in the hour
// would push "Snowing now". A summary with no start times is read from the
// beginning.
//
// Confirmed against live responses on 2026-07-27 (see the spec in
// docs/superpowers/specs/): the field is real, values are lowercase bare nouns,
// periods run in chronological order.
export function precipFromForecast(forecast: WeatherKitForecast, at?: string): Precip {
  const summary = forecast.forecastHourly?.summary;
  if (!summary?.length) return 'rain';

  const condition = periodFor(summary, at)?.condition;
  if (!condition) return 'rain';
  return WINTRY_CONDITIONS.has(condition) ? 'wintry' : 'rain';
}

function periodFor(summary: SummaryPeriod[], at: string | undefined): SummaryPeriod | undefined {
  if (at === undefined) return summary[0];

  const target = Date.parse(at);
  const starts = summary.map((period) => Date.parse(period.startTime ?? ''));
  let covering = 0;
  if (!starts.some(Number.isNaN)) {
    starts.forEach((start, i) => {
      if (start <= target) covering = i;
    });
  }
  return summary.slice(covering).find((period) => period.condition && period.condition !== 'clear');
}

function json(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// A malformed body should be a 400, not an unhandled throw that surfaces as a
// generic Worker 500.
async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

// /test-rain, /test-cron and /test-activity send real pushes and burn real
// WeatherKit quota, so they require a shared secret. Fails closed: if ADMIN_TOKEN was never set, the
// endpoints are unusable rather than open.
function isAuthorizedAdmin(request: Request, env: Env): boolean {
  const provided = request.headers.get('X-Admin-Token');
  if (!env.ADMIN_TOKEN || !provided) return false;
  return secureEquals(provided, env.ADMIN_TOKEN);
}

// A cross-origin POST with `Content-Type: text/plain` is a CORS "simple
// request": no preflight, so any web page could make each of its visitors
// register a device, spreading a flood across thousands of residential IPs —
// exactly the shape a per-client throttle cannot see. Demanding
// application/json forces a preflight, which, since we send no
// Access-Control-Allow-Origin, browsers refuse. Non-browser clients are
// unaffected; throttling them is the rate limiter's job, not this check's.
function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get('Content-Type') ?? '';
  return contentType.split(';')[0].trim().toLowerCase() === 'application/json';
}

interface RequestLogContext {
  code?: string;
  gridKey?: string;
  bucketPrefix?: string;
  reason?: string;
  retryAfterSeconds?: number;
  evictedCells?: string[];
}

// Front door for every state-changing endpoint. Returns a response to send
// instead of running the handler, or null to proceed.
//
// Every rejection here says what happened and when to come back, because the
// alternative — dropping a real user's registration on the floor and returning
// something they cannot act on — is how a rate limit turns into a silent
// outage.
async function guardMutation(
  request: Request,
  env: Env,
  options: { throttle: boolean },
  reqLog: RequestLogContext
): Promise<Response | null> {
  if (!hasJsonContentType(request)) {
    reqLog.code = 'unsupported_media_type';
    return json(
      {
        error: 'Content-Type must be application/json.',
        code: 'unsupported_media_type',
      },
      415
    );
  }

  if (!options.throttle) return null;

  const rate = await checkRegistrationRate(request, env);
  if (rate.bucketPrefix) reqLog.bucketPrefix = rate.bucketPrefix;
  if (!rate.ok) {
    reqLog.code = 'rate_limited';
    reqLog.retryAfterSeconds = rate.retryAfterSeconds;
    return json(
      {
        error:
          'Too many registration requests from this network. Alerts already set up are unaffected; retry shortly.',
        code: 'rate_limited',
        retryAfterSeconds: rate.retryAfterSeconds,
      },
      429,
      { 'Retry-After': String(rate.retryAfterSeconds) }
    );
  }

  return null;
}

export default {
  // HTTP API for device registration
  async fetch(request: Request, env: Env): Promise<Response> {
    const startMs = Date.now();
    const url = new URL(request.url);
    const reqLog: RequestLogContext = {};

    const dispatch = async (): Promise<Response> => {
      // /register and /register-activity are throttled: they are the two routes
      // that grow stored state and, through it, the cron's WeatherKit bill. The
      // two teardown routes are only content-type checked — a user leaving should
      // never be told to come back later.
      if (request.method === 'POST' && url.pathname === '/register') {
        return (
          (await guardMutation(request, env, { throttle: true }, reqLog)) ??
          handleRegister(request, env, reqLog)
        );
      }

      if (request.method === 'DELETE' && url.pathname === '/unregister') {
        return (
          (await guardMutation(request, env, { throttle: false }, reqLog)) ??
          handleUnregister(request, env, reqLog)
        );
      }

      if (request.method === 'POST' && url.pathname === '/register-activity') {
        return (
          (await guardMutation(request, env, { throttle: true }, reqLog)) ??
          handleRegisterActivity(request, env, reqLog)
        );
      }

      if (request.method === 'POST' && url.pathname === '/unregister-activity') {
        return (
          (await guardMutation(request, env, { throttle: false }, reqLog)) ??
          handleUnregisterActivity(request, env, reqLog)
        );
      }

      if (request.method === 'POST' && url.pathname === '/test-rain') {
        if (!isAuthorizedAdmin(request, env)) {
          reqLog.code = 'unauthorized';
          return json({ error: 'Unauthorized' }, 401);
        }
        return handleTestRain(request, env, reqLog);
      }

      if (request.method === 'POST' && url.pathname === '/test-activity') {
        if (!isAuthorizedAdmin(request, env)) {
          reqLog.code = 'unauthorized';
          return json({ error: 'Unauthorized' }, 401);
        }
        return handleTestActivity(request, env, reqLog);
      }

      if (request.method === 'POST' && url.pathname === '/test-cron') {
        if (!isAuthorizedAdmin(request, env)) {
          reqLog.code = 'unauthorized';
          return json({ error: 'Unauthorized' }, 401);
        }
        return handleTestCron(request, env, reqLog);
      }

      reqLog.code = 'not_found';
      return new Response('Not found', { status: 404 });
    };

    try {
      const response = await dispatch();
      const durationMs = Date.now() - startMs;
      const fields = {
        method: request.method,
        route: url.pathname,
        status: response.status,
        durationMs,
        code: reqLog.code,
        gridKey: reqLog.gridKey,
        bucketPrefix: reqLog.bucketPrefix,
        reason: reqLog.reason,
        retryAfterSeconds: reqLog.retryAfterSeconds,
        evictedCells: reqLog.evictedCells,
      };
      if (response.status >= 500) {
        logError('http.request', fields);
      } else if (response.status >= 400) {
        logWarn('http.request', fields);
      } else {
        logInfo('http.request', fields);
      }
      return response;
    } catch (err) {
      logError('http.request', {
        method: request.method,
        route: url.pathname,
        status: 500,
        code: 'unhandled_exception',
        durationMs: Date.now() - startMs,
        gridKey: reqLog.gridKey,
        bucketPrefix: reqLog.bucketPrefix,
        error: formatError(err),
      });
      throw err;
    }
  },

  // Cron trigger: check weather for all registered devices
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const tickStartMs = Date.now();
    logInfo('cron.start', {
      scheduledTime:
        typeof _event?.scheduledTime === 'number' && Number.isFinite(_event.scheduledTime)
          ? new Date(_event.scheduledTime).toISOString()
          : undefined,
    });

    let cellsTotal = 0;
    let cellsProcessed = 0;
    let cellsSkipped = 0;
    let weatherkitOk = 0;
    let weatherkitErr = 0;
    let weatherkitTimeout = 0;
    let apnsSent = 0;
    let apnsFailed = 0;
    let apns410Reaped = 0;
    let activitySent = 0;
    let activityFailed = 0;
    let queuedReapsDrained = 0;
    let coverageTruncated = false;
    let allGrids: GridCell[] = [];
    const reapedTokens = new Set<string>();
    const budget = createPushBudget();

    try {
      const coverage = await readCoverage(env);
      allGrids = coverage.grids;
      cellsTotal = coverage.grids.length;
      coverageTruncated = coverage.truncated;
      if (coverage.truncated) {
        logError('cron.coverage_truncated', {
          maxDeviceRecords: MAX_DEVICE_RECORDS,
          cellsTotal,
          reason: 'max_device_records_reached',
        });
      }

      await migrateLegacyRecords(coverage.legacy, env);

      // Hand the registry what KV actually holds, so its tally cannot drift as
      // records expire. Skipped after a truncated read: a partial picture must
      // never be written back as the truth.
      if (!coverage.truncated) await reconcileCoverage(coverage.grids, env);

      // One WeatherKit fetch per cell, all inside this one invocation: without a
      // ceiling here, enough registrations exhaust the Free plan's external
      // subrequest budget and take the whole tick down.
      const { cells: grids, skipped } = selectCellsWithinCap(coverage.grids);
      cellsSkipped = skipped;
      if (skipped > 0) {
        logError('cron.cell_cap_hit', {
          serving: grids.length,
          cellsTotal: coverage.grids.length,
          skipped,
          maxGridCells: MAX_GRID_CELLS,
        });
      }

      // Every push below is an external subrequest out of the same 50 the
      // WeatherKit fetches come from. The budget makes exhaustion deterministic —
      // selectCellsWithinCap has ordered both the cells and the devices inside
      // them oldest-first, and this loop is sequential, so the users who were here
      // longest are the ones served — instead of letting the runtime throw "Too
      // many subrequests" into a catch that swallows it.
      const reaps = createReapBudget();

      // Tokens APNs has already rejected, waiting on the reap budget. Draining
      // them here rather than only when a push happens to fail is what makes the
      // queue finite: the push loop below skips whatever is still flagged, so a
      // flagged device never fails another push and would otherwise sit in KV
      // holding a cell slot until its 14-day TTL ran out.
      //
      // Draining first also fixes the precedence. notifyOnce writes its dedup key
      // only after the push resolves, so a throwing push leaves nothing behind and
      // is retried next tick; devices are walked oldest-first and a long-
      // uninstalled device has the oldest registeredAt; so an unguarded backlog
      // spends the push budget on the dead before the living, every tick until it
      // clears. Cleanup must never outrank an alert.
      //
      // readPendingReaps fails open to an empty set, so a registry blip costs some
      // wasted pushes rather than the whole tick.
      // The set stays whole after draining, because it is also the skip list: this
      // tick's readCoverage snapshot was taken before the deletes below, so a
      // device reaped here is still in `grid.devices` and pushing to it would be
      // pure waste.
      const pendingReaps = await readPendingReaps(env);
      let queuedReaps = pendingReaps.size;
      for (const deviceToken of pendingReaps) {
        if (!reaps.spend()) break;
        try {
          await removeDevice(deviceToken, env);
          queuedReaps -= 1;
          queuedReapsDrained += 1;
          reapedTokens.add(deviceToken);
        } catch (err) {
          logError('cron.reap_failed', {
            reason: 'queued_reap_failed',
            error: formatError(err),
          });
        }
      }
      if (queuedReaps > 0) {
        logError('cron.reap_backlog', {
          count: queuedReaps,
          maxDeviceReapsPerTick: MAX_DEVICE_REAPS_PER_TICK,
        });
      }

      // Live Activity updates are the optional half of a tick and must never be
      // able to take the mandatory half down with them — the same invariant the
      // per-push catches below state. Unguarded, a `list` that throws here aborts
      // scheduled() before a single rain alert goes out, which is the product's
      // entire purpose. Degrade to "no Live Activity updates this tick" instead:
      // the next tick retries, and the card keeps refreshing on-device meanwhile.
      let activityTokens = new Map<string, string>();
      try {
        activityTokens = await readActivityTokens(env);
      } catch (err) {
        logError('cron.activity_tokens_unavailable', {
          reason: 'activity_list_failed',
          error: formatError(err),
        });
      }

      const processGrid = async (grid: GridCell) => {
        const { lat, lon } = gridCenter(grid.gridKey);
        let forecast: WeatherKitForecast;
        try {
          forecast = await fetchForecast(lat, lon, env, grid.gridKey);
          weatherkitOk += 1;
        } catch (err) {
          weatherkitErr += 1;
          if (isTimeoutError(err)) weatherkitTimeout += 1;
          return;
        }

        try {
          const now = Date.now();
          // Minute data where WeatherKit has it, the hourly forecast where it does
          // not — without the fallback every device outside minute coverage was
          // silently unalertable.
          const minutes = nextHourMinutes(forecast, now);
          if (!minutes || minutes.length === 0) return;

          const rainingNow = isWet(minutes[0]);

          // Rain START: first wet minute ahead — only relevant if it isn't already raining.
          const rainStart = rainingNow ? undefined : minutes.find(isWet);
          // Rain END: if it's raining now, the first upcoming dry minute (rain tapering off).
          const rainEnd = rainingNow ? minutes.find((m) => !isWet(m)) : undefined;
          // Rain RESUMING: the break rainEnd opens begins before the next tick, and
          // more rain follows it inside the hour — the server's half of the app's
          // "More rain coming" alert. It is announced as the break opens because
          // the next tick's start alert is exactly what the 30-minute floor
          // swallows after a short shower.
          const afterBreak = rainEnd ? minutes.slice(minutes.indexOf(rainEnd)).find(isWet) : undefined;
          const rainResume =
            rainEnd &&
            afterBreak &&
            Math.round((new Date(rainEnd.startTime).getTime() - now) / 60000) <= CRON_PERIOD_MINUTES &&
            new Date(afterBreak.startTime).getTime() > now
              ? afterBreak
              : undefined;

          // Nothing to say only when it is dry now and stays dry. Steady rain —
          // wet now with no dry minute anywhere in the series, so neither
          // rainStart nor rainEnd exists — sends no alert, but a running Live
          // Activity still needs its refresh: returning here left the card
          // frozen on whatever the last push said for as long as the rain held.
          if (!rainingNow && !rainStart) return;
          const minutesUntilEnd = rainEnd
            ? Math.round((new Date(rainEnd.startTime).getTime() - now) / 60000)
            : undefined;

          const precip = precipFromForecast(forecast, rainStart?.startTime);
          const copy = copyFor(precip);
          // Logged so the summary schema can be checked against real responses
          // rather than trusted from Apple's docs — a wintry value has never yet
          // been seen in the wild (spec, "Server changes are load-bearing").
          logInfo('cron.grid_precip', {
            gridKey: grid.gridKey,
            precip,
            summary: forecast.forecastHourly?.summary?.map((s) => s.condition) ?? null,
          });

          // At most one push per device per event type, deduped via KV. Both kinds
          // are floored at ALERT_FLOOR_MINUTES since the last one sent. A rain
          // start carries a second test past that floor: the record names the
          // onset it announced, so the shower a long lead time watches approach
          // for the best part of an hour stays one event, while a genuinely
          // different shower still earns its own alert — the client keys on the
          // onset the same way (`isSameEvent`, NotificationService.swift).
          //
          // A record with no onset in it was written before that keying and stands
          // for whatever rain the device was last told about, so it goes on
          // suppressing until it expires rather than repeating an alert on deploy.
          //
          // A resume shares the start record, so whichever announces an onset
          // first, the other stays silent for it. The one difference: to a resume,
          // a record a start alert wrote whose onset has already begun is spent —
          // that is the rain now breaking, and the rain after the break is a
          // different event however soon after the last alert it comes. A record
          // a resume wrote is never spent, so in flickering rain one resume holds
          // the next ones to the floor. The record names its kind for that.
          const notifyOnce = async (
            device: DeviceRegistration,
            kind: 'start' | 'resume' | 'end',
            onsetTime: string | undefined,
            send: () => Promise<void>
          ): Promise<boolean> => {
            const onsetMinute =
              onsetTime === undefined ? undefined : Math.round(new Date(onsetTime).getTime() / 60_000);
            const keyPrefix = kind === 'end' ? 'notified-end' : 'notified-start';
            const metaKey = `${keyPrefix}:${device.token}`;
            let recorded: string | null;
            try {
              recorded = await env.DEVICES.get(metaKey);
            } catch (err) {
              logError('kv.error', {
                op: 'get',
                keyPrefix,
                gridKey: grid.gridKey,
                error: formatError(err),
              });
              throw err;
            }
            if (recorded !== null) {
              const [notifiedAt, notifiedOnset, notifiedKind] = recorded.split(':');
              const spent =
                kind === 'resume' &&
                notifiedKind !== 'resume' &&
                notifiedOnset !== undefined &&
                parseInt(notifiedOnset) * 60_000 <= now;
              if (!spent) {
                if (now - parseInt(notifiedAt) <= ALERT_FLOOR_MINUTES * 60 * 1000) return false;
                if (
                  onsetMinute !== undefined &&
                  (notifiedOnset === undefined ||
                    Math.abs(parseInt(notifiedOnset) - onsetMinute) <= SAME_ONSET_DRIFT_MINUTES)
                ) {
                  return false;
                }
              }
            }
            // Claimed after the dedup check, so a push we were never going to
            // send does not spend budget a later device could have used.
            if (!budget.spend()) return false;
            try {
              await send();
              apnsSent += 1;
            } catch (err) {
              apnsFailed += 1;
              logError('cron.alert_failed', {
                gridKey: grid.gridKey,
                kind,
                status: err instanceof APNsError ? err.status : undefined,
                reason: err instanceof APNsError ? err.reason : undefined,
                timeout: isTimeoutError(err),
                error: formatError(err),
              });
              const failure = await recordPushFailure(device.token, err, env, reaps);
              if (failure.reaped) reapedTokens.add(device.token);
              if (failure.reaped410) apns410Reaped += 1;
              return false;
            }

            // The record has to outlive the span it suppresses. A resume can
            // announce rain further out than the lead time, so its span runs
            // to its own onset.
            const spanMinutes =
              kind === 'resume' && onsetMinute !== undefined
                ? onsetMinute - Math.floor(now / 60_000)
                : device.leadTimeMinutes;
            try {
              await env.DEVICES.put(
                metaKey,
                onsetMinute === undefined ? now.toString() : `${now}:${onsetMinute}:${kind}`,
                {
                  expirationTtl:
                    onsetMinute === undefined
                      ? 3600
                      : Math.max(3600, (spanMinutes + SAME_ONSET_DRIFT_MINUTES) * 60),
                }
              );
            } catch (err) {
              logError('kv.error', {
                op: 'put',
                keyPrefix,
                gridKey: grid.gridKey,
                reason: 'dedup_write_failed',
                error: formatError(err),
              });
            }
            return true;
          };

          for (const device of grid.devices) {
            if (pendingReaps.has(device.token)) continue;
            const activityToken = activityTokens.get(device.token);
            const alertsQuiet = isInQuietHours(device, new Date(now));
            if (rainStart && device.rainStartEnabled !== false) {
              const minutesUntilRain = Math.round((new Date(rainStart.startTime).getTime() - now) / 60000);
              // Widened by one cron period: at a 10-minute lead time the alert window
              // equalled the tick period exactly, so a tick could see rain at 10.6m
              // (rounds to 11, no alert) and the next tick fire with under a minute to
              // spare — any cron delay turned that into a miss. Firing slightly early
              // is the safe direction for a rain warning.
              // The START_SLACK_MINUTES slack stays: `rainStart` can be a minute
              // already in the past, so a negative `minutesUntilRain` is reachable
              // here, not dead — see "still fire when the feed says the rain began a
              // few minutes ago" in cron-alerts.test.ts.
              if (
                minutesUntilRain <= device.leadTimeMinutes + CRON_PERIOD_MINUTES &&
                minutesUntilRain >= -START_SLACK_MINUTES
              ) {
                if (!alertsQuiet) {
                  const sent = await notifyOnce(device, 'start', rainStart.startTime, () =>
                    sendRainAlert(
                      device.token,
                      minutesUntilRain,
                      env,
                      intensityFromMmPerHr(rainStart.precipitationIntensity)
                    )
                  );
                  if (sent) {
                    logInfo('cron.alert_sent', {
                      gridKey: grid.gridKey,
                      kind: 'start',
                      minutesUntil: minutesUntilRain,
                      precip,
                    });
                  }
                }

                // Live Activity: rain incoming (State A). Only relevant within the same
                // lead-time window as the alert above; a push failure here must never
                // break the alert-push loop.
                if (activityToken && budget.spend()) {
                  try {
                    const segments = computeSegments(minutes, isWet, now, ACTIVITY_WINDOW_MINUTES);
                    const contentState: LiveActivityContentState = {
                      statusText: copy.incoming,
                      countdownTarget: encodeActivityDate(new Date(now + minutesUntilRain * 60000)),
                      heroText: null,
                      subBold: copy.expected,
                      subRest: ' · next hour',
                      boldFirst: true,
                      rightText: '',
                      segments,
                      windowMinutes: ACTIVITY_WINDOW_MINUTES,
                      midLabel: '+45 min',
                      endLabel: '+90 min',
                      // No flag from the server: DeviceRegistration has no timezone, so a
                      // clock time would render in UTC. The app's own refreshes set it.
                      flagText: null,
                      flagPosition: null,
                      precip,
                    };
                    // The rain-start transition: the card is about rain on its way.
                    await sendLiveActivityUpdate(activityToken, contentState, env, {
                      event: 'update',
                      priority: LIVE_ACTIVITY_PRIORITY.transition,
                    });
                    activitySent += 1;
                    logInfo('activity.sent', {
                      gridKey: grid.gridKey,
                      kind: 'rain_start',
                      activityEvent: 'update',
                      priority: LIVE_ACTIVITY_PRIORITY.transition,
                      precip,
                    });
                  } catch (err) {
                    activityFailed += 1;
                    logError('activity.failed', {
                      gridKey: grid.gridKey,
                      kind: 'rain_start',
                      status: err instanceof APNsError ? err.status : undefined,
                      reason: err instanceof APNsError ? err.reason : undefined,
                      timeout: isTimeoutError(err),
                      error: formatError(err),
                    });
                    await discardDeadActivityToken(device.token, err, env);
                  }
                }
              }
            }
            // A resume is a start-kind alert, so it follows the rain-start opt-out.
            const resume = device.rainStartEnabled !== false ? rainResume : undefined;
            if (resume && !alertsQuiet) {
              const minutesUntilResume = Math.round((new Date(resume.startTime).getTime() - now) / 60000);
              const sent = await notifyOnce(device, 'resume', resume.startTime, () =>
                sendRainResumeAlert(device.token, minutesUntilResume, env)
              );
              if (sent) {
                logInfo('cron.alert_sent', {
                  gridKey: grid.gridKey,
                  kind: 'resume',
                  minutesUntil: minutesUntilResume,
                  precip,
                });
              }
            }
            if (minutesUntilEnd !== undefined && device.rainEndEnabled !== false) {
              // The resume above speaks for this break. Saying "Rain ending soon"
              // as well would read as the end of it, and a second `notified-*`
              // read would break the one-per-device count in abuse.ts.
              if (!resume && !alertsQuiet && minutesUntilEnd <= 30 && minutesUntilEnd >= -5) {
                const sent = await notifyOnce(device, 'end', undefined, () =>
                  sendRainEndAlert(device.token, env, minutesUntilEnd)
                );
                if (sent) {
                  logInfo('cron.alert_sent', {
                    gridKey: grid.gridKey,
                    kind: 'end',
                    minutesUntil: minutesUntilEnd,
                    precip,
                  });
                }
              }
            }

            // Live Activity while it is raining (State B), every tick, independent
            // of the alert's 30-min/dedup gate above and of the notification
            // toggles: the card is something the user started and is looking at,
            // and rainEndEnabled says only whether they want an alert. Gating the
            // card on it left a user who had switched that alert off with a card
            // frozen on its last push until it went stale. Three shapes:
            //   - a dry minute ahead: the countdown to it (keepalive);
            //   - no dry minute in the whole series (steady rain): the same state
            //     with no countdown, refreshed so it never goes stale (keepalive);
            //   - the dry minute has arrived: the terminal state, ending the
            //     activity and dropping its token (transition).
            // A push failure here must never break the alert loop.
            if (rainingNow && activityToken && budget.spend()) {
              try {
                if (minutesUntilEnd === undefined || minutesUntilEnd > 0) {
                  const segments = computeSegments(minutes, isWet, now, ACTIVITY_WINDOW_MINUTES);
                  const contentState: LiveActivityContentState =
                    minutesUntilEnd === undefined
                      ? {
                          statusText: copy.fallingNow,
                          countdownTarget: null,
                          heroText: copy.fallingHero,
                          subBold: 'no break in the next hour',
                          subRest: copy.fallingVerb,
                          boldFirst: false,
                          rightText: '',
                          segments,
                          windowMinutes: ACTIVITY_WINDOW_MINUTES,
                          midLabel: '+45 min',
                          endLabel: '+90 min',
                          flagText: null,
                          flagPosition: null,
                          precip,
                        }
                      : {
                          statusText: copy.fallingNow,
                          countdownTarget: encodeActivityDate(new Date(now + minutesUntilEnd * 60000)),
                          heroText: null,
                          subBold: `stops in about ${minutesUntilEnd} min`,
                          subRest: copy.fallingVerb,
                          boldFirst: false,
                          rightText: '',
                          segments,
                          windowMinutes: ACTIVITY_WINDOW_MINUTES,
                          midLabel: '+45 min',
                          endLabel: '+90 min',
                          flagText: null,
                          flagPosition: null,
                          precip,
                        };
                  await sendLiveActivityUpdate(activityToken, contentState, env, {
                    event: 'update',
                    priority: LIVE_ACTIVITY_PRIORITY.keepalive,
                  });
                  activitySent += 1;
                  logInfo('activity.sent', {
                    gridKey: grid.gridKey,
                    kind: minutesUntilEnd === undefined ? 'steady_rain' : 'raining_now',
                    activityEvent: 'update',
                    priority: LIVE_ACTIVITY_PRIORITY.keepalive,
                    precip,
                    minutesUntilEnd,
                  });
                } else {
                  const contentState: LiveActivityContentState = {
                    statusText: copy.ended,
                    countdownTarget: null,
                    heroText: 'Clear',
                    subBold: copy.hasStopped,
                    subRest: '',
                    boldFirst: true,
                    rightText: '',
                    segments: [],
                    windowMinutes: ACTIVITY_WINDOW_MINUTES,
                    midLabel: '+45 min',
                    endLabel: '+90 min',
                    flagText: null,
                    flagPosition: null,
                    precip,
                  };
                  await sendLiveActivityUpdate(activityToken, contentState, env, {
                    event: 'end',
                    priority: LIVE_ACTIVITY_PRIORITY.transition,
                  });
                  await clearActivityToken(device.token, env);
                  activitySent += 1;
                  logInfo('activity.sent', {
                    gridKey: grid.gridKey,
                    kind: 'rain_end',
                    activityEvent: 'end',
                    priority: LIVE_ACTIVITY_PRIORITY.transition,
                    precip,
                  });
                }
              } catch (err) {
                activityFailed += 1;
                logError('activity.failed', {
                  gridKey: grid.gridKey,
                  kind: 'raining_now',
                  status: err instanceof APNsError ? err.status : undefined,
                  reason: err instanceof APNsError ? err.reason : undefined,
                  timeout: isTimeoutError(err),
                  error: formatError(err),
                });
                await discardDeadActivityToken(device.token, err, env);
              }
            }
          }
        } catch (err) {
          logError('cron.grid_error', {
            gridKey: grid.gridKey,
            error: formatError(err),
          });
        }
      };

      for (const grid of grids) {
        cellsProcessed += 1;
        await processGrid(grid);
      }

      if (budget.denied > 0) {
        logError('cron.push_budget_exhausted', {
          sent: budget.spent,
          limit: PUSH_BUDGET_PER_INVOCATION,
          dropped: budget.denied,
        });
      }
    } finally {
      const cellsEmptiedByReap = allGrids.filter(
        (g) => g.devices.length > 0 && g.devices.every((d) => reapedTokens.has(d.token))
      ).length;
      logInfo('cron.summary', {
        cellsTotal,
        cellsProcessed,
        cellsSkipped,
        evictedCells: cellsSkipped + cellsEmptiedByReap,
        weatherkitOk,
        weatherkitErr,
        weatherkitTimeout,
        apnsSent,
        apnsFailed,
        apns410Reaped,
        activitySent,
        activityFailed,
        pushBudgetDropped: budget.denied,
        queuedReapsDrained,
        truncated: coverageTruncated,
        durationMs: Date.now() - tickStartMs,
      });
    }
  },
};

// Records written before DEVICE_RECORD_TTL_SECONDS existed carry no expiration,
// and KV can only set one at write time — so nothing but a rewrite gives them
// one, and until they get one they are immortal and, being the oldest, first in
// line for every scarce cell slot.
//
// The rewrite goes back to the key the record was *read* under, not to one
// rebuilt from its `token` field. That is what makes this loop terminate by
// construction: a record whose body disagreed with its key — hand-written,
// truncated, missing a token — would otherwise leave the original TTL-less key
// untouched, so it would come back every tick, consume the whole per-tick
// migration budget forever, and write a fresh `device:undefined` each time.
async function migrateLegacyRecords(legacy: LegacyRecord[], env: Env): Promise<void> {
  const batch = legacy.slice(0, MAX_TTL_MIGRATIONS_PER_TICK);
  if (batch.length === 0) return;

  let migrated = 0;
  for (const record of batch) {
    try {
      await putDeviceRecordAtKey(record.key, record.device, env);
      migrated += 1;
    } catch (err) {
      logWarn('kv.error', {
        op: 'put',
        keyPrefix: 'device',
        reason: 'legacy_ttl_migration_failed',
        error: formatError(err),
      });
    }
  }

  logInfo('cron.ttl_migration', {
    count: migrated,
    remaining: legacy.length - batch.length,
  });
}

// Collapse the minute-by-minute forecast into contiguous wet stretches, normalized
// to 0...1 fractions of `windowMinutes` — this is what the Live Activity ring/bar
// renders. WeatherKit's forecastNextHour only covers ~60 minutes, so a 90-minute
// window will simply have no segment data past that point.
function computeSegments(
  minutes: Array<{ startTime: string; precipitationChance: number; precipitationIntensity: number }>,
  isWet: (m: { precipitationChance: number; precipitationIntensity: number }) => boolean,
  now: number,
  windowMinutes: number
): Array<{ start: number; end: number }> {
  const segments: Array<{ start: number; end: number }> = [];
  let stretchStartMinutes: number | null = null;

  for (const m of minutes) {
    const offsetMinutes = (new Date(m.startTime).getTime() - now) / 60000;
    if (offsetMinutes > windowMinutes) break;

    if (isWet(m)) {
      if (stretchStartMinutes === null) stretchStartMinutes = Math.max(0, offsetMinutes);
    } else if (stretchStartMinutes !== null) {
      segments.push({ start: stretchStartMinutes / windowMinutes, end: offsetMinutes / windowMinutes });
      stretchStartMinutes = null;
    }
  }
  if (stretchStartMinutes !== null) {
    segments.push({ start: stretchStartMinutes / windowMinutes, end: 1 });
  }

  return segments;
}


// A rejected Live Activity push means the activity itself is over — the user
// dismissed it, or it aged out — not that the device is gone. Drop only the
// activity token so the device keeps receiving ordinary rain alerts, and stop
// pushing to a token APNs has already refused.
async function discardDeadActivityToken(deviceToken: string, err: unknown, env: Env): Promise<void> {
  if (!(err instanceof APNsError)) return;
  if (!err.isUnregistered && !err.isBadDeviceToken) return;
  await clearActivityToken(deviceToken, env);
  logInfo('activity.token_cleared', {
    status: err.status,
    reason: err.reason,
  });
}

/** The fields a `/register` body can actually change. */
interface RegistrationSettings {
  lat: number;
  lon: number;
  leadTimeMinutes: number;
  rainStartEnabled: boolean;
  rainEndEnabled: boolean;
  quietHoursEnabled: boolean;
  quietHoursStartMinutes: number;
  quietHoursEndMinutes: number;
  timeZoneIdentifier: string;
}

type WriteDecision = 'write' | 'unchanged' | 'cooling-down' | 'opt-outs-only';

/**
 * Whether this registration is persisted now, and if not, why not.
 *
 * The order below is the whole contract, and each step earns its place:
 *
 *   1. no stored record       -> the caller writes; a first registration is
 *                                never deferred (handled by the caller).
 *   2. TTL refresh due        -> write, always. Captain ruling R1's dormant-user
 *                                guarantee rests on this, so nothing may
 *                                override it.
 *   3. grid key changed       -> write immediately, no cooldown. A device that
 *                                moved cells must not keep being alerted for
 *                                the cell it left: that is the silent wrong-area
 *                                break this whole change exists to prevent, and
 *                                it outranks the adversarial write-drain bound
 *                                the cooldown was reaching for. The narrowed
 *                                claim in abuse.ts concedes that bound honestly
 *                                rather than pretending the cooldown closes it.
 *   4. same cell, unchanged   -> skip. The common case: the client re-registers
 *                                on cold launch, on every foreground and after
 *                                every poll, and almost all of it is a repeat.
 *   5. alert enabled -> off,
 *      nothing turned on      -> write immediately. An explicit opt-out must
 *                                never wait behind an abuse cooldown.
 *   6. same cell, changed,
 *      inside the cooldown    -> return an explicit 202 deferral. The client
 *                                retries after the remaining cooldown instead
 *                                of mistaking stale settings for success. If
 *                                the request also turns an alert off, that
 *                                opt-out alone is written first ('opt-outs-only')
 *                                and the 202 covers the rest: the client sends
 *                                its whole policy, so an opt-out often travels
 *                                with a re-enable still waiting out the cooldown.
 *
 * Steps 5 and 6 write inside the cooldown only to turn alerts off, so each such
 * write shrinks the set of enabled alerts: at most two can follow any write that
 * re-enables them, which keeps the cooldown a bound rather than something to
 * alternate past.
 *
 * A record with no `renewedAt` counts as refresh-due: it predates the field, so
 * there is no evidence of when it was last written and guessing young would risk
 * the very expiry step 2 exists to prevent.
 *
 * Cell changes remain immediate and are never part of the deferral protocol.
 */
function writeDecision(
  existing: DeviceRegistration,
  settings: RegistrationSettings
): WriteDecision {
  // Coordinates are compared at grid precision, not as raw doubles. Every
  // registration the app sends carries a fresh CoreLocation fix, and two fixes
  // are never byte-identical, so comparing the doubles would report "changed"
  // on every foreground and the skip below could never fire. The grid key is
  // the only precision the server ever consumes — the cron fetches weather for
  // `gridCenter(gridKey)`, never for the device's own lat/lon — so jitter
  // inside a ~5.5 km cell genuinely changes nothing. A user who moves to a
  // different cell changes the key, and that still writes.
  //
  // The consequence is that the stored lat/lon can lag the device's latest fix
  // by up to one cell. That is deliberate and harmless for the same reason.
  const renewedAt = existing.renewedAt ? Date.parse(existing.renewedAt) : Number.NaN;
  const sinceWrite = Number.isNaN(renewedAt)
    ? Number.POSITIVE_INFINITY
    : Date.now() - renewedAt;

  if (sinceWrite >= DEVICE_RECORD_REFRESH_SECONDS * 1000) return 'write';

  if (toGridKey(existing.lat, existing.lon) !== toGridKey(settings.lat, settings.lon)) {
    return 'write';
  }

  const startWas = existing.rainStartEnabled ?? true;
  const endWas = existing.rainEndEnabled ?? true;
  const disablesAlert =
    (startWas && !settings.rainStartEnabled) || (endWas && !settings.rainEndEnabled);
  const enablesAlert =
    (!startWas && settings.rainStartEnabled) || (!endWas && settings.rainEndEnabled);
  if (disablesAlert && !enablesAlert) return 'write';

  const changed =
    existing.leadTimeMinutes !== settings.leadTimeMinutes ||
    (existing.rainStartEnabled ?? true) !== settings.rainStartEnabled ||
    (existing.rainEndEnabled ?? true) !== settings.rainEndEnabled ||
    (existing.quietHoursEnabled ?? false) !== settings.quietHoursEnabled ||
    (existing.quietHoursStartMinutes ?? 22 * 60) !== settings.quietHoursStartMinutes ||
    (existing.quietHoursEndMinutes ?? 7 * 60) !== settings.quietHoursEndMinutes ||
    (existing.timeZoneIdentifier ?? 'UTC') !== settings.timeZoneIdentifier;
  if (!changed) return 'unchanged';

  if (sinceWrite >= DEVICE_REWRITE_COOLDOWN_SECONDS * 1000) return 'write';
  return disablesAlert ? 'opt-outs-only' : 'cooling-down';
}

function rewriteCooldownRemainingSeconds(existing: DeviceRegistration): number {
  const renewedAt = existing.renewedAt ? Date.parse(existing.renewedAt) : Number.NaN;
  if (Number.isNaN(renewedAt)) return 0;
  const elapsed = Math.max(0, Date.now() - renewedAt);
  return Math.max(1, Math.ceil(DEVICE_REWRITE_COOLDOWN_SECONDS - elapsed / 1000));
}

// Every write of a `device:` record goes through here so none can silently
// re-create the immortal, TTL-less record this replaced. Re-writing resets the
// clock, which is correct: every path that writes one is driven by a live
// device — a registration, a Live Activity the device started, or a push it
// accepted.
async function putDeviceRecord(
  deviceToken: string,
  registration: DeviceRegistration,
  env: Env
): Promise<void> {
  await putDeviceRecordAtKey(`device:${deviceToken}`, registration, env);
}

// The one place a `device:` record is actually written. Callers that already
// hold the KV key — the legacy-TTL migration reads it from the listing — use
// this directly rather than rebuilding the key from the record body.
async function putDeviceRecordAtKey(
  key: string,
  registration: DeviceRegistration,
  env: Env
): Promise<void> {
  const renewed: DeviceRegistration = { ...registration, renewedAt: new Date().toISOString() };
  await env.DEVICES.put(key, JSON.stringify(renewed), {
    expirationTtl: DEVICE_RECORD_TTL_SECONDS,
  });
}

function activityKey(deviceToken: string): string {
  return `activity:${deviceToken}`;
}

// The activity token is duplicated into the key's metadata so the cron can read
// every device's token with one `list` instead of one `get` per device. iOS
// Live Activities cannot outlive 12 hours (8h active + 4h on Lock Screen), so
// ACTIVITY_RECORD_TTL_SECONDS (24h) expires stale tokens automatically even if
// the app never called `/unregister-activity`.
//
// Re-submitting a token that is already stored writes nothing. `/register-activity`
// shares `/register`'s per-IP throttle bucket, so without this one address could
// spend 20 x 144 = 2,880 puts a day against an allowance of 1,000 — the same
// adversarial drain DEVICE_REWRITE_COOLDOWN_SECONDS bounds on the `device:` side,
// paid for the same way: a `get` comes from the 100,000-a-day read allowance,
// which is two orders of magnitude larger than the write one.
//
// A NEW or CHANGED token is always persisted immediately — never deferred, never
// cooled down. Every server-side Live Activity update depends on it, so holding
// one back would silently break the activity the user just started, which is the
// same reasoning that exempts a genuine cell change from the rewrite cooldown.
async function putActivityToken(
  deviceToken: string,
  activityToken: string,
  env: Env
): Promise<void> {
  const key = activityKey(deviceToken);
  let stored: string | null;
  try {
    stored = await env.DEVICES.get(key);
  } catch (err) {
    logError('kv.error', { op: 'get', keyPrefix: 'activity', error: formatError(err) });
    throw err;
  }
  if (stored !== null && storedActivityToken(stored) === activityToken) return;

  const record: ActivityRegistration = {
    activityToken,
    activityUpdatedAt: new Date().toISOString(),
  };
  try {
    await env.DEVICES.put(key, JSON.stringify(record), {
      expirationTtl: ACTIVITY_RECORD_TTL_SECONDS,
      metadata: { activityToken } satisfies ActivityKeyMetadata,
    });
  } catch (err) {
    logError('kv.error', { op: 'put', keyPrefix: 'activity', error: formatError(err) });
    throw err;
  }
}

// A record this Worker cannot parse is treated as absent, so the caller rewrites
// it rather than skipping on a value nothing can read.
function storedActivityToken(raw: string): string | null {
  try {
    return (JSON.parse(raw) as ActivityRegistration).activityToken ?? null;
  } catch {
    return null;
  }
}

// Drop the stored activity token once its Live Activity has been ended.
//
// The read is not waste and must not be "optimised" away as one. It is the same
// invariant removeDevice states below — a delete has to be earned by something
// actually being there — and it is load-bearing for the same reason:
// `/unregister-activity` is deliberately unthrottled, because a user tearing
// down must never be told to come back later, so an unconditional delete would
// let anyone spend one KV delete per request on a fabricated token. The
// economics are lopsided on purpose: KV deletes come out of their own
// 1,000-a-day allowance — separate from the 1,000 writes, so a delete-driven
// amplifier cannot be reasoned about against the write budget — while a `get`
// comes out of the 100,000-a-day read allowance. Read-then-conditional-delete
// is therefore strictly the cheaper shape against the budget that binds here.
// Drain the delete allowance and removeDevice throws for the rest of the day,
// so `/unregister` 500s and the cron cannot reap dead tokens.
async function clearActivityToken(deviceToken: string, env: Env): Promise<void> {
  const key = activityKey(deviceToken);
  let existing: string | null;
  try {
    existing = await env.DEVICES.get(key);
  } catch (err) {
    logError('kv.error', { op: 'get', keyPrefix: 'activity', error: formatError(err) });
    throw err;
  }
  if (existing === null) return;
  try {
    await env.DEVICES.delete(key);
  } catch (err) {
    logError('kv.error', { op: 'delete', keyPrefix: 'activity', error: formatError(err) });
    throw err;
  }
}

async function handleTestRain(
  request: Request,
  env: Env,
  reqLog: RequestLogContext
): Promise<Response> {
  const body = await readJson<{ token?: unknown; minutesUntilRain?: unknown }>(request);
  if (!body) {
    reqLog.code = 'bad_request';
    reqLog.reason = 'malformed_json';
    return json({ error: 'Malformed JSON body' }, 400);
  }

  if (!isValidDeviceToken(body.token)) {
    reqLog.code = 'bad_request';
    reqLog.reason = 'invalid_token';
    return json({ error: 'Invalid or missing token' }, 400);
  }

  const minutesUntilRain =
    typeof body.minutesUntilRain === 'number' && Number.isFinite(body.minutesUntilRain)
      ? Math.round(body.minutesUntilRain)
      : 10;

  try {
    await sendRainAlert(body.token, minutesUntilRain, env);
    return json({ ok: true, minutesUntilRain });
  } catch (err) {
    reqLog.code = 'apns_failed';
    reqLog.reason = formatError(err);
    return json({ error: String(err) }, 500);
  }
}

// Pushes a content-state at a device's Live Activity, on demand.
//
// This is the only way to exercise the server -> Live Activity path without
// waiting for real weather: the cron pushes activity updates, but only for a
// device that has an activity token AND sits in a grid that is currently
// precipitating. Until this existed the path had never run against a real
// activity token even once.
//
// It matters most for `precip`. `content-state` is a full replacement, so the
// server's payload — not the app's — decides whether a card reads as snow or
// rain from the next tick onward. A body without `precip` reproduces a Worker
// that predates the field and must leave the card ticking in rain colours
// rather than freezing it.
//
// Admin-gated, so it sits outside the cron's push budget on purpose: it is one
// push per operator request, not a fan-out, and it must not be able to starve a
// tick of budget it never touches.
async function handleTestActivity(
  request: Request,
  env: Env,
  reqLog: RequestLogContext
): Promise<Response> {
  const body = await readJson<{
    token?: unknown; precip?: unknown; event?: unknown; minutesUntil?: unknown;
  }>(request);
  if (!body) {
    reqLog.code = 'bad_request';
    reqLog.reason = 'malformed_json';
    return json({ error: 'Malformed JSON body' }, 400);
  }

  if (!isValidDeviceToken(body.token)) {
    reqLog.code = 'bad_request';
    reqLog.reason = 'invalid_token';
    return json({ error: 'Invalid or missing token' }, 400);
  }

  const registration = await env.DEVICES.get(`device:${body.token}`);
  if (registration === null) {
    reqLog.code = 'device_not_registered';
    return json({ error: 'Device not registered' }, 404);
  }

  // The activity token lives under its own `activity:` key (see types.ts for
  // why it is not a field on the device record), and only in a `get`'s body —
  // the metadata copy exists for the cron's one-list read, not for this.
  const stored = await env.DEVICES.get(activityKey(body.token));
  const activityToken = stored === null ? null : storedActivityToken(stored);
  if (!activityToken) {
    reqLog.code = 'activity_token_missing';
    return json({
      error: 'Device has no activity token — no Live Activity is running, or the '
        + 'app never reported its push token',
    }, 409);
  }

  // Absence is meaningful here (the legacy-payload case), so only an actual
  // 'wintry' or 'rain' sets the field; anything else leaves it out.
  const precip: Precip | undefined =
    body.precip === 'wintry' ? 'wintry' : body.precip === 'rain' ? 'rain' : undefined;
  const event = body.event === 'end' ? 'end' : 'update';
  const minutesUntil =
    typeof body.minutesUntil === 'number' && Number.isFinite(body.minutesUntil)
      ? Math.round(body.minutesUntil)
      : 25;
  const copy = copyFor(precip ?? 'rain');

  // `precip` is required on LiveActivityContentState precisely so no production
  // path can forget it — a payload without it silently reverts a snowing card
  // to rain. This test needs to send exactly that payload on purpose, so it
  // relaxes the field here and nowhere else.
  const contentState: Omit<LiveActivityContentState, 'precip'> & { precip?: Precip } = {
    statusText: copy.incoming,
    countdownTarget: encodeActivityDate(new Date(Date.now() + minutesUntil * 60000)),
    heroText: null,
    subBold: copy.expected,
    subRest: ' · test push',
    boldFirst: true,
    rightText: 'Test',
    segments: [{ start: 0.2, end: 0.6 }],
    windowMinutes: ACTIVITY_WINDOW_MINUTES,
    midLabel: '+45 min',
    endLabel: '+90 min',
    flagText: null,
    flagPosition: null,
  };
  if (precip) contentState.precip = precip;

  try {
    // A hand-sent test push is one the operator wants to see now, so it goes
    // at transition priority rather than waiting on the phone's discretion.
    await sendLiveActivityUpdate(activityToken, contentState, env, {
      event,
      priority: LIVE_ACTIVITY_PRIORITY.transition,
    });
    // Same as the cron's own end path: the activity is over, so drop its token
    // now rather than letting the next precipitating tick spend a push on a
    // token APNs will reject before discardDeadActivityToken reaps it.
    if (event === 'end') await clearActivityToken(body.token, env);
    return json({ ok: true, event, precip: precip ?? null, minutesUntil });
  } catch (err) {
    await discardDeadActivityToken(body.token, err, env);
    reqLog.code = 'apns_failed';
    reqLog.reason = formatError(err);
    return json({ error: String(err) }, 500);
  }
}

// Runs the cron's detection logic for one coordinate and reports what it saw.
//
// `dryRun: true` skips the push, which makes this usable as a plain forecast
// probe against any coordinate — no device has to exist there and nobody's
// phone buzzes. That is the only way to answer "does WeatherKit actually
// populate forecastHourly.summary[].condition, and with what values?", since
// the cron's own summary log only fires for a grid that already has a
// registered device AND active precipitation. backend/test/probe-weatherkit-summary.sh
// drives it.
async function handleTestCron(
  request: Request,
  env: Env,
  reqLog: RequestLogContext
): Promise<Response> {
  const body = await readJson<{
    token?: unknown; lat?: unknown; lon?: unknown; dryRun?: unknown;
  }>(request);
  if (!body) {
    reqLog.code = 'bad_request';
    reqLog.reason = 'malformed_json';
    return json({ error: 'Malformed JSON body' }, 400);
  }

  if (!isValidDeviceToken(body.token)) {
    reqLog.code = 'bad_request';
    reqLog.reason = 'invalid_token';
    return json({ error: 'Invalid or missing token' }, 400);
  }
  if (!isValidLatitude(body.lat) || !isValidLongitude(body.lon)) {
    reqLog.code = 'bad_request';
    reqLog.reason = 'invalid_coordinates';
    return json({ error: 'Invalid or missing lat/lon' }, 400);
  }
  const gridKey = toGridKey(body.lat, body.lon);
  reqLog.gridKey = gridKey;
  const dryRun = body.dryRun === true;

  try {
    const forecast = await fetchForecast(body.lat, body.lon, env, gridKey);
    const now = Date.now();
    const minutes = nextHourMinutes(forecast, now);
    const rainStart = minutes?.find(isWet);
    const rainingNow = !!minutes?.length && isWet(minutes[0]);

    // The raw conditions, not just the derived value: if Apple renames a case
    // or ships one WINTRY_CONDITIONS does not know about, `precip` alone would
    // read as a confident "rain" and hide it.
    const summary = forecast.forecastHourly?.summary?.map((s) => s.condition) ?? null;
    const diagnostics = {
      precip: precipFromForecast(forecast, rainingNow ? undefined : rainStart?.startTime),
      summary,
      dryRun,
    };

    if (!minutes || minutes.length === 0) {
      return json({ ok: true, result: 'no_forecast_data', ...diagnostics });
    }

    if (!rainStart) {
      return json({ ok: true, result: 'no_rain', minutesChecked: minutes.length, ...diagnostics });
    }

    const rainStartTime = new Date(rainStart.startTime).getTime();
    const minutesUntilRain = Math.round((rainStartTime - now) / 60000);

    if (!dryRun) {
      await sendRainAlert(body.token, minutesUntilRain, env);
    }
    return json({
      ok: true,
      result: 'rain_detected',
      minutesUntilRain,
      precipitationChance: rainStart.precipitationChance,
      precipitationIntensity: rainStart.precipitationIntensity,
      ...diagnostics,
    });
  } catch (err) {
    reqLog.code = 'test_cron_failed';
    reqLog.reason = formatError(err);
    return json({ error: String(err) }, 500);
  }
}

async function handleRegister(
  request: Request,
  env: Env,
  reqLog: RequestLogContext
): Promise<Response> {
  const body = await readJson<{
    token?: unknown;
    lat?: unknown;
    lon?: unknown;
    leadTimeMinutes?: unknown;
    rainStartEnabled?: unknown;
    rainEndEnabled?: unknown;
    quietHoursEnabled?: unknown;
    quietHoursStartMinutes?: unknown;
    quietHoursEndMinutes?: unknown;
    timeZoneIdentifier?: unknown;
  }>(request);
  if (!body) {
    reqLog.code = 'bad_request';
    reqLog.reason = 'malformed_json';
    return json({ error: 'Malformed JSON body' }, 400);
  }

  if (!isValidDeviceToken(body.token)) {
    reqLog.code = 'bad_request';
    reqLog.reason = 'invalid_token';
    return json({ error: 'Invalid or missing token' }, 400);
  }
  if (!isValidLatitude(body.lat) || !isValidLongitude(body.lon)) {
    reqLog.code = 'bad_request';
    reqLog.reason = 'invalid_coordinates';
    return json({ error: 'Invalid or missing lat/lon' }, 400);
  }
  const quietHoursEnabled = asBoolean(body.quietHoursEnabled, false);
  if (
    (body.quietHoursStartMinutes !== undefined && !isValidMinuteOfDay(body.quietHoursStartMinutes)) ||
    (body.quietHoursEndMinutes !== undefined && !isValidMinuteOfDay(body.quietHoursEndMinutes)) ||
    (body.timeZoneIdentifier !== undefined && !isValidTimeZoneIdentifier(body.timeZoneIdentifier)) ||
    (quietHoursEnabled &&
      (!isValidMinuteOfDay(body.quietHoursStartMinutes) ||
        !isValidMinuteOfDay(body.quietHoursEndMinutes) ||
        !isValidTimeZoneIdentifier(body.timeZoneIdentifier)))
  ) {
    reqLog.code = 'bad_request';
    reqLog.reason = 'invalid_quiet_hours';
    return json({ error: 'Invalid quiet-hours policy' }, 400);
  }

  const gridKey = toGridKey(body.lat, body.lon);
  reqLog.gridKey = gridKey;

  // Read before write. A fresh literal here would erase two things the request
  // does not carry: the Live Activity push token (which the client only ever
  // sends once, on Activity.request, while it re-registers after every weather
  // poll — so a literal wipes it within minutes and the server-side Live
  // Activity branches never fire again), and `registeredAt`, which is what
  // selectCellsWithinCap ranks cells by. Restamping `registeredAt` on every
  // re-registration would invert that ranking: an active install would look
  // newer than a planted record nobody has touched in three days, and the
  // planted ones would take the cell slots.
  //
  // A failed read must not fall through to writing a fresh literal — that is
  // exactly the erasure this read exists to prevent — so it refuses instead,
  // legibly and before any cell slot has been claimed.
  let existing: DeviceRegistration | null;
  try {
    existing = (await env.DEVICES.get(`device:${body.token}`, 'json')) as DeviceRegistration | null;
  } catch (err) {
    logError('kv.error', {
      op: 'get',
      keyPrefix: 'device',
      gridKey,
      reason: 'read_existing_registration_failed',
      error: formatError(err),
    });
    reqLog.code = 'storage_unavailable';
    return json(
      {
        error: 'Registration storage is temporarily unavailable. Existing alerts are unaffected; retry shortly.',
        code: 'storage_unavailable',
      },
      503,
      { 'Retry-After': '60' }
    );
  }

  const settings: RegistrationSettings = {
    lat: body.lat,
    lon: body.lon,
    leadTimeMinutes: clampLeadTimeMinutes(body.leadTimeMinutes),
    rainStartEnabled: asBoolean(body.rainStartEnabled, true),
    rainEndEnabled: asBoolean(body.rainEndEnabled, true),
    quietHoursEnabled,
    quietHoursStartMinutes: isValidMinuteOfDay(body.quietHoursStartMinutes)
      ? body.quietHoursStartMinutes
      : 22 * 60,
    quietHoursEndMinutes: isValidMinuteOfDay(body.quietHoursEndMinutes)
      ? body.quietHoursEndMinutes
      : 7 * 60,
    timeZoneIdentifier: isValidTimeZoneIdentifier(body.timeZoneIdentifier)
      ? body.timeZoneIdentifier
      : 'UTC',
  };

  // Opening a *new* grid cell is the expensive act: it adds ~4,383 WeatherKit
  // calls a month, forever. Registering into a cell the service already covers
  // costs nothing extra and is always allowed, so an existing user is never
  // turned away by the cap.
  //
  // A device with a stored record at this very gridKey is an incumbent: it is
  // already in KV and the cron already fetches its cell, so admitting it adds
  // nothing. Saying so explicitly means the "never refuse a device
  // re-registering at its own unchanged cell" invariant rests on KV — the same
  // storage that decides whether the device exists at all — rather than on the
  // registry's tally, which an eventually consistent cron snapshot can lag.
  const incumbent =
    existing !== null && toGridKey(existing.lat, existing.lon) === gridKey;
  const cell = await reserveGridCell(gridKey, body.token, env, { incumbent });
  if (!cell.ok) {
    const code = cell.code ?? 'coverage_at_capacity';
    reqLog.code = code;
    logError('register.capacity_refused', {
      code,
      gridKey,
      cells: cell.cells,
      maxGridCells: MAX_GRID_CELLS,
      devices: cell.devices,
      maxDevicesPerCell: MAX_DEVICES_PER_CELL,
    });
    // A device that really was registered gets that registration dropped:
    // leaving it in place would keep pushing rain alerts for wherever the user
    // used to be, which is worse than no alerts at all.
    //
    // Only then, though. This is the abuse gate, so refusing has to cost us less
    // than it costs the caller, and `removeDevice` is two KV deletes plus a
    // round trip to the one global CoverageRegistry. Spending that on a
    // fabricated token that was never registered — the overwhelmingly common
    // case in a flood — would turn every refusal into an amplifier against the
    // Free plan's daily KV DELETE allowance, which is 1,000 a day and separate
    // from the write allowance. The reserve call above has already
    // released whatever cell slot this token held, so skipping here leaks
    // nothing.
    if (existing) {
      try {
        await removeDevice(body.token, env);
      } catch (err) {
        logError('kv.error', {
          op: 'delete',
          keyPrefix: 'device',
          gridKey,
          reason: 'clear_stale_on_capacity_refusal',
          error: formatError(err),
        });
      }
    }

    const atCell = cell.code === 'cell_at_capacity';
    return json(
      {
        error: atCell
          ? 'This area already has as many registered devices as the service can notify. ' +
            'Any earlier registration for this device has been cleared, so it will not keep ' +
            'sending alerts for a previous location; retry later to set alerts up again.'
          : 'This service is at its coverage limit and cannot take on a new area right now. ' +
            'Any earlier registration for this device has been cleared, so it will not keep ' +
            'sending alerts for a previous location; retry later to set alerts up again.',
        code,
        maxGridCells: MAX_GRID_CELLS,
        maxDevicesPerCell: MAX_DEVICES_PER_CELL,
      },
      503,
      { 'Retry-After': '3600' }
    );
  }

  if (cell.evictedTokens && cell.evictedTokens.length > 0) {
    reqLog.evictedCells = cell.evictedCells;
    logInfo('register.evict_dormant', {
      gridKey,
      evictedCells: cell.evictedCells ?? [],
      count: cell.evictedTokens.length,
    });
    await evictDormantDevicesFromKV(cell.evictedTokens, env);
  }

  // Decided AFTER the cell is reserved, and that ordering is load-bearing.
  // `reserve` is the only path that clears a device's pending-reap flag, which
  // is what puts a device APNs once rejected — a wrong APNS_ENV window, say —
  // back into the push rotation. Returning before it would leave a live device
  // that re-registers unchanged flagged and silently muted until the reap queue
  // drained to it and deleted its record outright. The "this device is alive"
  // signal has to be independent of whether we persist any bytes.
  //
  // Reserving first is safe precisely because a cell change is never deferred:
  // every decision that reaches here other than 'write' is same-cell, so the
  // reserve above was a no-op relocation and there is no cell to leak.
  //
  // A first registration has no stored record, so it is never deferred, and the
  // gridKey reported back is always the one now stored.
  if (existing) {
    const decision = writeDecision(existing, settings);
    if (decision === 'opt-outs-only') {
      try {
        await putDeviceRecord(
          body.token,
          {
            ...existing,
            rainStartEnabled: (existing.rainStartEnabled ?? true) && settings.rainStartEnabled,
            rainEndEnabled: (existing.rainEndEnabled ?? true) && settings.rainEndEnabled,
          },
          env
        );
      } catch (err) {
        logError('kv.error', {
          op: 'put',
          keyPrefix: 'device',
          gridKey,
          reason: 'opt_outs_only_write_failed',
          error: formatError(err),
        });
        reqLog.code = 'kv_write_failed';
        return json({ error: 'KV write failed' }, 500);
      }
    }
    if (decision !== 'write') {
      reqLog.reason = decision;
      if (decision !== 'unchanged') {
        const retryAfterSeconds =
          decision === 'opt-outs-only'
            ? DEVICE_REWRITE_COOLDOWN_SECONDS
            : rewriteCooldownRemainingSeconds(existing);
        reqLog.code = 'rewrite_cooldown';
        reqLog.retryAfterSeconds = retryAfterSeconds;
        return json(
          { ok: false, deferred: true, retryAfterSeconds, gridKey },
          202,
          { 'Retry-After': String(retryAfterSeconds) }
        );
      }
      return json({ ok: true, gridKey });
    }
  }

  const registration: DeviceRegistration = {
    ...(existing ?? {}),
    ...settings,
    token: body.token,
    registeredAt: existing?.registeredAt ?? new Date().toISOString(),
  };

  // Key by device token for easy lookup/update
  try {
    // Location and push token are the two pieces of user data here — log that a
    // write happened, not what was written. The record carries a TTL, which is
    // what makes junk transient: a live install rewrites its own on cold launch,
    // on foreground and after every weather poll, a fabricated one never does
    // (see DEVICE_RECORD_TTL_SECONDS).
    await putDeviceRecord(body.token, registration, env);
    reqLog.reason = existing ? 'updated' : 'created';
  } catch (err) {
    logError('kv.error', {
      op: 'put',
      keyPrefix: 'device',
      gridKey,
      error: formatError(err),
    });
    reqLog.code = 'kv_write_failed';
    return json({ error: 'KV write failed' }, 500);
  }

  return json({ ok: true, gridKey });
}

async function handleUnregister(
  request: Request,
  env: Env,
  reqLog: RequestLogContext
): Promise<Response> {
  const body = await readJson<{ token?: unknown }>(request);
  if (!body) {
    reqLog.code = 'bad_request';
    reqLog.reason = 'malformed_json';
    return json({ error: 'Malformed JSON body' }, 400);
  }
  if (!isValidDeviceToken(body.token)) {
    reqLog.code = 'bad_request';
    reqLog.reason = 'invalid_token';
    return json({ error: 'Invalid or missing token' }, 400);
  }

  await removeDevice(body.token, env);

  return json({ ok: true });
}

// Drops a device: the two keys that would otherwise outlive it, and its cell
// slot. Deliberately NOT every key keyed off its token — `notified-start:`,
// `notified-end:` and `apnsfail:` are left to their own TTLs: an hour, or the
// span one rain-start onset stays alertable for where that is longer, and 86400s.
//
// Deleting those three bought an hour or a day of tidiness for three fifths of
// this function's delete cost, against a Free-plan allowance of 1,000 deletes a
// day that is separate from the write allowance and that unthrottled teardown
// draws on directly. Two consequences follow, and both are accepted rather than
// overlooked:
//
//   * A device reaped and re-registering while a `notified-*` key of its own
//     outlives it — an hour, or up to 75 minutes for `notified-start:` at the
//     longest lead time the app offers — may still be suppressed by it. That key
//     exists only because the device was already notified for that rain event,
//     and the start key names the very onset it announced, so the suppression
//     drops a duplicate rather than a distinct alert.
//   * A device re-registering within 24h carries its surviving `apnsfail:`
//     strike count, so it can be reaped after fewer fresh failures. Bounded by
//     BAD_TOKEN_STRIKES, and every strike reflects a real APNs rejection.
//
// The cell slot goes back too. Without that, a cell whose devices had all left
// would stay "already covered" and hold a slot that nothing occupies.
//
// Tearing down a device that was never registered costs nothing, and that is
// load-bearing rather than tidy. `/unregister` is deliberately unthrottled — a
// user leaving must never be told to come back later — so without this check
// anyone could spend two KV deletes and a round trip to the one global
// CoverageRegistry per request, on fabricated tokens, and drain the day's
// delete allowance in a single burst. Deletes and the registry call have to be
// earned by something actually being there.
async function removeDevice(deviceToken: string, env: Env): Promise<void> {
  const key = `device:${deviceToken}`;
  let existing: string | null;
  try {
    existing = await env.DEVICES.get(key);
  } catch (err) {
    logError('kv.error', { op: 'get', keyPrefix: 'device', error: formatError(err) });
    throw err;
  }
  if (existing === null) return;

  const deleteDevice = async () => {
    try {
      await env.DEVICES.delete(key);
    } catch (err) {
      logError('kv.error', { op: 'delete', keyPrefix: 'device', error: formatError(err) });
      throw err;
    }
  };

  await Promise.all([
    deleteDevice(),
    clearActivityToken(deviceToken, env),
    releaseGridCell(deviceToken, env),
  ]);
}

// Clears KV records for devices whose dormant cell CoverageRegistry already
// evicted atomically during /reserve. Reads first so expired keys spend no KV
// deletes and a device that concurrently woke up and wrote a fresh record is
// left intact.
async function evictDormantDevicesFromKV(deviceTokens: string[], env: Env): Promise<void> {
  const dormantMs = DORMANT_CELL_THRESHOLD_SECONDS * 1000;
  const now = Date.now();
  await Promise.allSettled(
    deviceTokens.map(async (token) => {
      try {
        const raw = await env.DEVICES.get(`device:${token}`);
        if (raw === null) return;
        try {
          const parsed = JSON.parse(raw) as Partial<DeviceRegistration>;
          const ts = Date.parse(parsed.renewedAt ?? parsed.registeredAt ?? '');
          if (Number.isFinite(ts) && now - ts < dormantMs) return;
        } catch {
          // Malformed record — proceed with deleting it.
        }
        await Promise.all([
          env.DEVICES.delete(`device:${token}`),
          clearActivityToken(token, env),
        ]);
      } catch (err) {
        logError('kv.error', {
          op: 'delete',
          keyPrefix: 'device',
          reason: 'evict_dormant_failed',
          error: formatError(err),
        });
      }
    })
  );
}

// Decides whether a push failure means the device is gone.
//
// A 410 is APNs stating outright that the token is dead, so act on it at once.
// BadDeviceToken needs more care: it is also what every single device returns
// when APNS_ENV points at the wrong APNs host, so treating one as fatal would
// let a config typo wipe the whole device list in a single cron tick. Requiring
// several strikes inside the counter's 24h TTL keeps that from happening, and
// still clears genuinely dead tokens within an hour. The app re-registers on
// every foreground, so an over-eager delete heals itself.
//
// `reaps` bounds how many devices one tick may drop, because each is 2 KV
// deletes out of a daily allowance the cron cannot otherwise limit. Refusing
// defers rather than loses: the strike count is not written back when the
// threshold was already reached, and a 410 recurs, so the next tick reaps the
// same token.
//
// A deferred token is flagged in the registry so the push loop stops walking it
// while it waits. Without that it would cost a push on every tick until its
// turn came — notifyOnce writes its dedup key only after the push resolves, so
// a throwing push leaves nothing behind — and oldest-first ordering puts
// long-uninstalled devices ahead of live ones, so a backlog would spend the
// budget on the dead before the living.
async function recordPushFailure(
  deviceToken: string,
  err: unknown,
  env: Env,
  reaps: TickBudget
): Promise<{ reaped: boolean; reaped410: boolean }> {
  if (!(err instanceof APNsError)) return { reaped: false, reaped410: false };

  const reap = async (reason: string, is410: boolean): Promise<{ reaped: boolean; reaped410: boolean }> => {
    if (!reaps.spend()) {
      await flagPendingReap(deviceToken, env);
      logError('apns.reap_budget_exhausted', {
        reason,
        status: err.status,
        apnsReason: err.reason,
        maxDeviceReapsPerTick: MAX_DEVICE_REAPS_PER_TICK,
      });
      return { reaped: false, reaped410: false };
    }
    await removeDevice(deviceToken, env);
    logInfo('apns.token_reaped', {
      reason,
      status: err.status,
      apnsReason: err.reason,
    });
    return { reaped: true, reaped410: is410 };
  };

  if (err.isUnregistered) {
    return reap('unregistered', true);
  }

  if (!err.isBadDeviceToken) return { reaped: false, reaped410: false };

  const key = `apnsfail:${deviceToken}`;
  let current = '0';
  try {
    current = (await env.DEVICES.get(key)) ?? '0';
  } catch (kvErr) {
    logError('kv.error', { op: 'get', keyPrefix: 'apnsfail', error: formatError(kvErr) });
    throw kvErr;
  }
  const strikes = parseInt(current, 10) + 1;
  if (strikes >= BAD_TOKEN_STRIKES) {
    return reap('bad_device_token_strikes', false);
  } else {
    try {
      await env.DEVICES.put(key, String(strikes), { expirationTtl: 86400 });
    } catch (kvErr) {
      logError('kv.error', { op: 'put', keyPrefix: 'apnsfail', error: formatError(kvErr) });
      throw kvErr;
    }
    logWarn('apns.bad_token_strike', {
      strikes,
      maxStrikes: BAD_TOKEN_STRIKES,
      status: err.status,
      apnsReason: err.reason,
    });
    return { reaped: false, reaped410: false };
  }
}

async function handleRegisterActivity(
  request: Request,
  env: Env,
  reqLog: RequestLogContext
): Promise<Response> {
  const body = await readJson<{ token?: unknown; activityToken?: unknown }>(request);
  if (!body) {
    reqLog.code = 'bad_request';
    reqLog.reason = 'malformed_json';
    return json({ error: 'Malformed JSON body' }, 400);
  }

  if (!isValidDeviceToken(body.token) || !isValidActivityToken(body.activityToken)) {
    reqLog.code = 'bad_request';
    reqLog.reason = 'invalid_token';
    return json({ error: 'Invalid or missing token or activityToken' }, 400);
  }

  let existing: string | null;
  try {
    existing = await env.DEVICES.get(`device:${body.token}`);
  } catch (err) {
    logError('kv.error', { op: 'get', keyPrefix: 'device', error: formatError(err) });
    throw err;
  }
  if (existing === null) {
    reqLog.code = 'device_not_registered';
    return json({ error: 'Device not registered' }, 404);
  }

  await putActivityToken(body.token, body.activityToken, env);
  reqLog.reason = 'registered';

  return json({ ok: true });
}

async function handleUnregisterActivity(
  request: Request,
  env: Env,
  reqLog: RequestLogContext
): Promise<Response> {
  const body = await readJson<{ token?: unknown }>(request);
  if (!body) {
    reqLog.code = 'bad_request';
    reqLog.reason = 'malformed_json';
    return json({ error: 'Malformed JSON body' }, 400);
  }
  if (!isValidDeviceToken(body.token)) {
    reqLog.code = 'bad_request';
    reqLog.reason = 'invalid_token';
    return json({ error: 'Invalid or missing token' }, 400);
  }

  await clearActivityToken(body.token, env);
  reqLog.reason = 'unregistered';

  return json({ ok: true });
}
