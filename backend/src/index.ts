import {
  ActivityKeyMetadata,
  ActivityRegistration,
  Env,
  DeviceRegistration,
  GridCell,
  LiveActivityContentState,
} from './types';
import { LegacyRecord, readActivityTokens, readCoverage, gridCenter, toGridKey } from './grid';
import { fetchForecast } from './weatherkit';
import { nextHourMinutes } from './nextHour';
import {
  APNsError,
  sendRainAlert,
  sendRainEndAlert,
  sendLiveActivityUpdate,
  encodeActivityDate,
  intensityFromMmPerHr,
} from './apns';
import {
  asBoolean,
  clampLeadTimeMinutes,
  isValidLatitude,
  isValidLongitude,
  isValidActivityToken,
  isValidDeviceToken,
  secureEquals,
} from './validate';
import {
  DEVICE_RECORD_REFRESH_SECONDS,
  DEVICE_REWRITE_COOLDOWN_SECONDS,
  DEVICE_RECORD_TTL_SECONDS,
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

// /test-rain and /test-cron send real pushes and burn real WeatherKit quota, so
// they require a shared secret. Fails closed: if ADMIN_TOKEN was never set, the
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
  options: { throttle: boolean }
): Promise<Response | null> {
  if (!hasJsonContentType(request)) {
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
  if (!rate.ok) {
    console.log(`[Abuse] Throttled a registration request for ${rate.retryAfterSeconds}s`);
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
    const url = new URL(request.url);

    // /register and /register-activity are throttled: they are the two routes
    // that grow stored state and, through it, the cron's WeatherKit bill. The
    // two teardown routes are only content-type checked — a user leaving should
    // never be told to come back later.
    if (request.method === 'POST' && url.pathname === '/register') {
      return (await guardMutation(request, env, { throttle: true })) ?? handleRegister(request, env);
    }

    if (request.method === 'DELETE' && url.pathname === '/unregister') {
      return (
        (await guardMutation(request, env, { throttle: false })) ?? handleUnregister(request, env)
      );
    }

    if (request.method === 'POST' && url.pathname === '/register-activity') {
      return (
        (await guardMutation(request, env, { throttle: true })) ??
        handleRegisterActivity(request, env)
      );
    }

    if (request.method === 'POST' && url.pathname === '/unregister-activity') {
      return (
        (await guardMutation(request, env, { throttle: false })) ??
        handleUnregisterActivity(request, env)
      );
    }

    if (request.method === 'POST' && url.pathname === '/test-rain') {
      if (!isAuthorizedAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
      return handleTestRain(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/test-cron') {
      if (!isAuthorizedAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
      return handleTestCron(request, env);
    }

    return new Response('Not found', { status: 404 });
  },

  // Cron trigger: check weather for all registered devices
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const coverage = await readCoverage(env);
    if (coverage.truncated) {
      console.error(
        `[Cron] Stopped reading device records at MAX_DEVICE_RECORDS=${MAX_DEVICE_RECORDS}; ` +
          `KV holds more than the registration caps allow, so this tick sees only part of the fleet.`
      );
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
    if (skipped > 0) {
      console.error(
        `[Cron] Grid-cell cap hit: serving the ${grids.length} oldest of ${coverage.grids.length} cells, ` +
          `skipping ${skipped}. Cap is MAX_GRID_CELLS=${MAX_GRID_CELLS}; raising it needs the ` +
          `subrequest arithmetic in abuse.ts re-run and the Workers Paid plan.`
      );
    }
    console.log(`[Cron] Processing ${grids.length} grid cells`);

    // Every push below is an external subrequest out of the same 50 the
    // WeatherKit fetches come from. The budget makes exhaustion deterministic —
    // selectCellsWithinCap has ordered both the cells and the devices inside
    // them oldest-first, and this loop is sequential, so the users who were here
    // longest are the ones served — instead of letting the runtime throw "Too
    // many subrequests" into a catch that swallows it.
    const budget = createPushBudget();
    const reaps = createReapBudget();

    // Tokens APNs has already rejected, waiting on the reap budget. Draining
    // them here rather than only when a push happens to fail is what makes the
    // queue finite: the push loop below skips whatever is still flagged, so a
    // flagged device never fails another push and would otherwise sit in KV
    // holding a cell slot until its 45-day TTL ran out.
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
      } catch (err) {
        console.error(`[Cron] Could not reap queued device: ${err}`);
      }
    }
    if (queuedReaps > 0) {
      console.error(
        `[Cron] ${queuedReaps} rejected device tokens still queued for deletion; the cap is ` +
          `MAX_DEVICE_REAPS_PER_TICK=${MAX_DEVICE_REAPS_PER_TICK}, sized from the Free plan's ` +
          `daily KV delete allowance in abuse.ts. They are skipped this tick and retried next.`
      );
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
      console.error(
        `[Cron] Could not read Live Activity tokens: ${err}. Rain alerts still go out this ` +
          `tick; no Live Activity is updated.`
      );
    }

    const processGrid = async (grid: GridCell) => {
      const { lat, lon } = gridCenter(grid.gridKey);
      try {
        const forecast = await fetchForecast(lat, lon, env);
        const now = Date.now();
        // Minute data where WeatherKit has it, the hourly forecast where it does
        // not — without the fallback every device outside minute coverage was
        // silently unalertable.
        const minutes = nextHourMinutes(forecast, now);
        if (!minutes || minutes.length === 0) return;

        const isWet = (m: { precipitationChance: number; precipitationIntensity: number }) =>
          m.precipitationChance > 0.3 && m.precipitationIntensity > 0;
        const rainingNow = isWet(minutes[0]);

        // Rain START: first wet minute ahead — only relevant if it isn't already raining.
        const rainStart = rainingNow ? undefined : minutes.find(isWet);
        // Rain END: if it's raining now, the first upcoming dry minute (rain tapering off).
        const rainEnd = rainingNow ? minutes.find((m) => !isWet(m)) : undefined;

        if (!rainStart && !rainEnd) return;

        // At most one push per device per event type, deduped for 30 min via KV.
        const notifyOnce = async (
          device: DeviceRegistration,
          kind: 'start' | 'end',
          send: () => Promise<void>
        ) => {
          const metaKey = `notified-${kind}:${device.token}`;
          const lastNotified = await env.DEVICES.get(metaKey);
          if (lastNotified && now - parseInt(lastNotified) < 30 * 60 * 1000) return;
          // Claimed after the dedup check, so a push we were never going to
          // send does not spend budget a later device could have used.
          if (!budget.spend()) return;
          try {
            await send();
            await env.DEVICES.put(metaKey, now.toString(), { expirationTtl: 3600 });
          } catch (err) {
            console.error(`[Cron] Failed to notify device (${kind}): ${err}`);
            await recordPushFailure(device.token, err, env, reaps);
          }
        };

        for (const device of grid.devices) {
          if (pendingReaps.has(device.token)) continue;
          const activityToken = activityTokens.get(device.token);
          if (rainStart && device.rainStartEnabled !== false) {
            const minutesUntilRain = Math.round((new Date(rainStart.startTime).getTime() - now) / 60000);
            if (minutesUntilRain <= device.leadTimeMinutes && minutesUntilRain >= -5) {
              await notifyOnce(device, 'start', () =>
                sendRainAlert(device.token, minutesUntilRain, env, intensityFromMmPerHr(rainStart.precipitationIntensity))
              );
              console.log(`[Cron] Rain-start grid ${grid.gridKey}, in ${minutesUntilRain}m`);

              // Live Activity: rain incoming (State A). Only relevant within the same
              // lead-time window as the alert above; a push failure here must never
              // break the alert-push loop.
              if (activityToken && budget.spend()) {
                try {
                  const segments = computeSegments(minutes, isWet, now, ACTIVITY_WINDOW_MINUTES);
                  const contentState: LiveActivityContentState = {
                    statusText: 'Rain incoming',
                    countdownTarget: encodeActivityDate(new Date(now + minutesUntilRain * 60000)),
                    heroText: null,
                    subBold: 'Rain expected',
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
                  };
                  await sendLiveActivityUpdate(activityToken, contentState, env);
                  console.log(`[Activity] Sent rain-start update, grid ${grid.gridKey}`);
                } catch (err) {
                  console.error(`[Activity] push failed: ${err}`);
                  await discardDeadActivityToken(device.token, err, env);
                }
              }
            }
          }
          if (rainEnd && device.rainEndEnabled !== false) {
            const minutesUntilEnd = Math.round((new Date(rainEnd.startTime).getTime() - now) / 60000);
            if (minutesUntilEnd <= 30 && minutesUntilEnd >= -5) {
              await notifyOnce(device, 'end', () => sendRainEndAlert(device.token, env, minutesUntilEnd));
              console.log(`[Cron] Rain-end grid ${grid.gridKey}, in ${minutesUntilEnd}m`);
            }

            // Live Activity: keep the countdown live every cron tick while it's still
            // raining (State B), independent of the alert's 30-min/dedup gate above.
            // Once the dry minute actually arrives, send the terminal state and drop
            // the activity token — a push failure here must never break the alert loop.
            if (activityToken && budget.spend()) {
              try {
                if (minutesUntilEnd > 0) {
                  const segments = computeSegments(minutes, isWet, now, ACTIVITY_WINDOW_MINUTES);
                  const contentState: LiveActivityContentState = {
                    statusText: 'Raining now',
                    countdownTarget: encodeActivityDate(new Date(now + minutesUntilEnd * 60000)),
                    heroText: null,
                    subBold: `stops in about ${minutesUntilEnd} min`,
                    subRest: 'Raining · ',
                    boldFirst: false,
                    rightText: '',
                    segments,
                    windowMinutes: ACTIVITY_WINDOW_MINUTES,
                    midLabel: '+45 min',
                    endLabel: '+90 min',
                    flagText: null,
                    flagPosition: null,
                  };
                  await sendLiveActivityUpdate(activityToken, contentState, env);
                } else {
                  const contentState: LiveActivityContentState = {
                    statusText: 'Rain ended',
                    countdownTarget: null,
                    heroText: 'Clear',
                    subBold: 'Rain has stopped',
                    subRest: '',
                    boldFirst: true,
                    rightText: '',
                    segments: [],
                    windowMinutes: ACTIVITY_WINDOW_MINUTES,
                    midLabel: '+45 min',
                    endLabel: '+90 min',
                    flagText: null,
                    flagPosition: null,
                  };
                  await sendLiveActivityUpdate(activityToken, contentState, env, 'end');
                  await clearActivityToken(device.token, env);
                  console.log(`[Activity] Sent rain-end (final) update, grid ${grid.gridKey}`);
                }
              } catch (err) {
                console.error(`[Activity] push failed: ${err}`);
                await discardDeadActivityToken(device.token, err, env);
              }
            }
          }
        }
      } catch (err) {
        console.error(`[Cron] Failed to fetch weather for grid ${grid.gridKey}: ${err}`);
      }
    };

    for (const grid of grids) {
      await processGrid(grid);
    }

    if (budget.denied > 0) {
      console.error(
        `[Cron] Push budget exhausted: sent ${budget.spent} of the ` +
          `PUSH_BUDGET_PER_INVOCATION=${PUSH_BUDGET_PER_INVOCATION} external pushes this tick and ` +
          `dropped ${budget.denied}. Those devices were NOT notified. See the subrequest arithmetic ` +
          `in abuse.ts before raising either the budget or MAX_GRID_CELLS.`
      );
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
      console.warn(`[Cron] Could not add a TTL to a legacy device record: ${err}`);
    }
  }

  console.log(
    `[Cron] Gave ${migrated} pre-TTL device record(s) an expiry; ${legacy.length - batch.length} still to go.`
  );
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
  console.log(`[Activity] Cleared dead activity token (${err.reason})`);
}

/** The fields a `/register` body can actually change. */
interface RegistrationSettings {
  lat: number;
  lon: number;
  leadTimeMinutes: number;
  rainStartEnabled: boolean;
  rainEndEnabled: boolean;
}

type WriteDecision = 'write' | 'unchanged' | 'cooling-down';

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
 *   5. same cell, changed,
 *      inside the cooldown    -> defer. Only settings can reach here
 *                                (leadTimeMinutes, rainStartEnabled,
 *                                rainEndEnabled), and it self-heals on the next
 *                                registration, which the client issues after
 *                                every successful poll.
 *
 * A record with no `renewedAt` counts as refresh-due: it predates the field, so
 * there is no evidence of when it was last written and guessing young would risk
 * the very expiry step 2 exists to prevent.
 *
 * If the adversarial rewrite drain ever shows up in real traffic, the fix that
 * was deliberately NOT taken here is an explicit deferral protocol — 202 with
 * `deferred: true` and a `retryAfterSeconds`, plus a client that records a
 * location only once the server confirms it stored it. That keeps a deferred
 * move retryable instead of silently dropped, which is what made deferring a
 * cell change unacceptable in the first place.
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
  // inside a ~1.1 km cell genuinely changes nothing. A user who moves to a
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

  const changed =
    existing.leadTimeMinutes !== settings.leadTimeMinutes ||
    (existing.rainStartEnabled ?? true) !== settings.rainStartEnabled ||
    (existing.rainEndEnabled ?? true) !== settings.rainEndEnabled;
  if (!changed) return 'unchanged';

  return sinceWrite >= DEVICE_REWRITE_COOLDOWN_SECONDS * 1000 ? 'write' : 'cooling-down';
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
// every device's token with one `list` instead of one `get` per device. The TTL
// matches the device record's, so an activity key can never outlive the device
// that owns it and become the immortal junk DEVICE_RECORD_TTL_SECONDS exists to
// prevent.
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
  const stored = await env.DEVICES.get(key);
  if (stored !== null && storedActivityToken(stored) === activityToken) return;

  const record: ActivityRegistration = {
    activityToken,
    activityUpdatedAt: new Date().toISOString(),
  };
  await env.DEVICES.put(key, JSON.stringify(record), {
    expirationTtl: DEVICE_RECORD_TTL_SECONDS,
    metadata: { activityToken } satisfies ActivityKeyMetadata,
  });
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
  const existing = await env.DEVICES.get(activityKey(deviceToken));
  if (existing === null) return;
  await env.DEVICES.delete(activityKey(deviceToken));
}

async function handleTestRain(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ token?: unknown; minutesUntilRain?: unknown }>(request);
  if (!body) return json({ error: 'Malformed JSON body' }, 400);

  if (!isValidDeviceToken(body.token)) {
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
    return json({ error: String(err) }, 500);
  }
}

async function handleTestCron(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ token?: unknown; lat?: unknown; lon?: unknown }>(request);
  if (!body) return json({ error: 'Malformed JSON body' }, 400);

  if (!isValidDeviceToken(body.token)) {
    return json({ error: 'Invalid or missing token' }, 400);
  }
  if (!isValidLatitude(body.lat) || !isValidLongitude(body.lon)) {
    return json({ error: 'Invalid or missing lat/lon' }, 400);
  }

  try {
    const forecast = await fetchForecast(body.lat, body.lon, env);
    const now = Date.now();
    const minutes = nextHourMinutes(forecast, now);

    if (!minutes || minutes.length === 0) {
      return new Response(JSON.stringify({ ok: true, result: 'no_forecast_data' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const rainStart = minutes.find(
      (m) => m.precipitationChance > 0.3 && m.precipitationIntensity > 0
    );

    if (!rainStart) {
      return new Response(JSON.stringify({ ok: true, result: 'no_rain', minutesChecked: minutes.length }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const rainStartTime = new Date(rainStart.startTime).getTime();
    const minutesUntilRain = Math.round((rainStartTime - now) / 60000);

    await sendRainAlert(body.token, minutesUntilRain, env);
    return new Response(JSON.stringify({
      ok: true,
      result: 'rain_detected',
      minutesUntilRain,
      precipitationChance: rainStart.precipitationChance,
      precipitationIntensity: rainStart.precipitationIntensity,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function handleRegister(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{
    token?: unknown;
    lat?: unknown;
    lon?: unknown;
    leadTimeMinutes?: unknown;
    rainStartEnabled?: unknown;
    rainEndEnabled?: unknown;
  }>(request);
  if (!body) return json({ error: 'Malformed JSON body' }, 400);

  if (!isValidDeviceToken(body.token)) {
    return json({ error: 'Invalid or missing token' }, 400);
  }
  if (!isValidLatitude(body.lat) || !isValidLongitude(body.lon)) {
    return json({ error: 'Invalid or missing lat/lon' }, 400);
  }

  const gridKey = toGridKey(body.lat, body.lon);

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
    console.error(`[Register] Could not read the existing registration: ${err}`);
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
    console.error(
      `[Register] Refused (${cell.code}): ${cell.cells}/${MAX_GRID_CELLS} cells, ` +
        `${cell.devices}/${MAX_DEVICES_PER_CELL} devices in this cell`
    );
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
        console.error(`[Register] Could not clear the stale registration: ${err}`);
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
        code: cell.code ?? 'coverage_at_capacity',
        maxGridCells: MAX_GRID_CELLS,
        maxDevicesPerCell: MAX_DEVICES_PER_CELL,
      },
      503,
      { 'Retry-After': '3600' }
    );
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
    if (decision !== 'write') {
      console.log(
        decision === 'unchanged'
          ? `[Register] Unchanged and still fresh, skipped the write for grid ${gridKey}`
          : `[Register] Same-cell settings change cooling down, kept grid ${gridKey} for now`
      );
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
    console.log(`[Register] Stored registration for grid ${gridKey}`);
  } catch (err) {
    console.error(`[Register] KV write failed: ${err}`);
    return json({ error: 'KV write failed' }, 500);
  }

  return json({ ok: true, gridKey });
}

async function handleUnregister(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ token?: unknown }>(request);
  if (!body) return json({ error: 'Malformed JSON body' }, 400);
  if (!isValidDeviceToken(body.token)) {
    return json({ error: 'Invalid or missing token' }, 400);
  }

  await removeDevice(body.token, env);

  return json({ ok: true });
}

// Drops a device: the two keys that would otherwise outlive it, and its cell
// slot. Deliberately NOT every key keyed off its token — `notified-start:`,
// `notified-end:` and `apnsfail:` are left to their own 3600s/86400s TTLs.
//
// Deleting those three bought an hour or a day of tidiness for three fifths of
// this function's delete cost, against a Free-plan allowance of 1,000 deletes a
// day that is separate from the write allowance and that unthrottled teardown
// draws on directly. Two consequences follow, and both are accepted rather than
// overlooked:
//
//   * A device reaped and re-registering within 30 minutes may still be
//     suppressed by its surviving `notified-*` key. That key exists only
//     because the device was already notified for that rain event, so the
//     suppression drops a duplicate rather than a distinct alert.
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
  const existing = await env.DEVICES.get(`device:${deviceToken}`);
  if (existing === null) return;

  await Promise.all([
    env.DEVICES.delete(`device:${deviceToken}`),
    clearActivityToken(deviceToken, env),
    releaseGridCell(deviceToken, env),
  ]);
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
): Promise<void> {
  if (!(err instanceof APNsError)) return;

  const reap = async (why: string): Promise<void> => {
    if (!reaps.spend()) {
      await flagPendingReap(deviceToken, env);
      console.error(
        `[APNs] Reap budget exhausted (MAX_DEVICE_REAPS_PER_TICK=${MAX_DEVICE_REAPS_PER_TICK}); ` +
          `deferring ${why} to the next tick. The device is skipped until then.`
      );
      return;
    }
    await removeDevice(deviceToken, env);
    console.log(`[APNs] ${why}`);
  };

  if (err.isUnregistered) {
    await reap('Dropped unregistered device token');
    return;
  }

  if (!err.isBadDeviceToken) return;

  const key = `apnsfail:${deviceToken}`;
  const strikes = parseInt((await env.DEVICES.get(key)) ?? '0', 10) + 1;
  if (strikes >= BAD_TOKEN_STRIKES) {
    await reap(`Dropped device after ${strikes} BadDeviceToken rejections`);
  } else {
    await env.DEVICES.put(key, String(strikes), { expirationTtl: 86400 });
    console.log(`[APNs] BadDeviceToken strike ${strikes}/${BAD_TOKEN_STRIKES}`);
  }
}

async function handleRegisterActivity(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ token?: unknown; activityToken?: unknown }>(request);
  if (!body) return json({ error: 'Malformed JSON body' }, 400);

  if (!isValidDeviceToken(body.token) || !isValidActivityToken(body.activityToken)) {
    return json({ error: 'Invalid or missing token or activityToken' }, 400);
  }

  const existing = await env.DEVICES.get(`device:${body.token}`);
  if (existing === null) {
    console.log(`[Activity] Register failed: no device for token`);
    return json({ error: 'Device not registered' }, 404);
  }

  await putActivityToken(body.token, body.activityToken, env);
  console.log(`[Activity] Registered activity token for device`);

  return json({ ok: true });
}

async function handleUnregisterActivity(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ token?: unknown }>(request);
  if (!body) return json({ error: 'Malformed JSON body' }, 400);
  if (!isValidDeviceToken(body.token)) {
    return json({ error: 'Invalid or missing token' }, 400);
  }

  await clearActivityToken(body.token, env);
  console.log(`[Activity] Unregistered activity token for device`);

  return json({ ok: true });
}
