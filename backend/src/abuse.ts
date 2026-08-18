// Abuse gate for the public registration endpoints.
//
// `POST /register` is unauthenticated by construction: the Worker URL ships
// inside the iOS binary and the only credential the app has is an APNs device
// token, which the Worker cannot verify. A security review exploited that by
// posting 250 fabricated tokens in 0.47s from a single client, each in its own
// coordinate, and every one of those coordinates became a permanent line item
// in the cron's WeatherKit fan-out.
//
// Three limits close that, and they are deliberately different in kind:
//
//   1. A per-client throttle bounds how fast anyone can register at all.
//   2. Hard ceilings on distinct grid cells, and on devices inside one cell,
//      bound the cron's per-tick cost and the number of areas the service will
//      ever track, no matter how many clients cooperate. The throttle can be
//      spread across a botnet; those two ceilings cannot.
//   3. A per-invocation push budget bounds what one cron tick can spend, so the
//      headroom the caps leave is real rather than notional.
//   4. A per-device rewrite cooldown bounds how often one registration can be
//      re-persisted, because the ceilings in (2) do not bound that.
//
// Be precise about what is NOT bounded, because an overclaim here is what sends
// the next reader looking in the wrong place. The cell and per-cell caps bound
// STORAGE SHAPE — cells tracked, records held, work per tick. They do not bound
// the daily KV WRITE allowance: a token can move between two cells forever
// without ever adding a cell or a record, and every move is a legitimate
// rewrite. The cooldown in (4) mitigates that and does not eliminate it — an
// attacker rotating enough tokens still writes at whatever rate the per-client
// throttle permits. The daily-allowance block below counts that term honestly
// rather than filing registration under "bounded".
//
// The first two are counted in Durable Objects (durable.ts) rather than KV,
// because KV cannot count a burst: its reads come from a colo-local cache with
// a 60-second floor, so every request in a sub-second flood reads the same
// pre-flood value.
//
// None of this authenticates anybody. Making fabricated tokens impossible needs
// App Attest (see the security review's item 9); this is the bound that holds
// until then.

import { CoverageMap, CoverageReply, DeviceRegistration, Env, GridCell, RateReply } from './types';

// ---------------------------------------------------------------------------
// The fan-out budget
// ---------------------------------------------------------------------------

// This Worker runs on the Cloudflare Workers FREE plan, which allows **50
// external subrequests per invocation** — one shared pool for everything the
// cron does over the network. Durable Object calls and KV operations are
// INTERNAL subrequests and come out of a separate 1,000-per-invocation bucket,
// so they must not be counted against the 50.
//
// One cron tick spends, out of that 50:
//
//   * 1 WeatherKit fetch per distinct grid cell            (weatherkit.ts)
//   * up to 2 pushes per notified device — the rain alert,
//     plus a Live Activity update when the device has an
//     activityToken                                        (apns.ts)
//
// so the ceiling on cells and the ceiling on pushes have to be chosen together:
//
//   MAX_GRID_CELLS             = 15 -> 15 external fetches, leaving 35 of the 50
//   PUSH_BUDGET_PER_INVOCATION = 34 -> 17 notified devices at 2 pushes each, +1
//                                      spare
//   MAX_DEVICES_PER_CELL       = 20 -> at most 15 x 20 = 300 device records
//
// The INTERNAL bucket has to be counted over the whole tick, not just over the
// read that dominates it. At the caps, with rain in every cell and every device
// eligible, one invocation spends:
//
//   PER DEVICE RECORD (2 each, so 600 at the caps):
//     1  KV get of the record itself                      readCoverage
//     1  KV get on `notified-*`, the dedup key             notifyOnce
//        — charged before budget.spend(), so every device
//          pays it whether or not it is notified
//
//   PER PUSH ATTEMPTED (6 each, so 204 at PUSH_BUDGET_PER_INVOCATION):
//     1  KV put on `notified-*`, the dedup key             notifyOnce
//     2  recordPushFailure taking a BadDeviceToken strike:
//        1 get + 1 put on `apnsfail:`
//     1  DO call flagging a rejected token for reaping     flagPendingReap
//     2  clearActivityToken on a terminal Live Activity:
//        1 get + 1 delete. It reads before deleting so an
//        unthrottled teardown cannot spend the daily KV
//        delete allowance on tokens never registered
//
//   PER DEVICE REAPED (5 each, so 10 at MAX_DEVICE_REAPS_PER_TICK):
//     1  KV get + 1 KV delete on `device:`                 removeDevice
//     2  clearActivityToken, 1 get + 1 delete — and the
//        delete only when the device actually held one, so
//        a device that never started a Live Activity costs
//        1 KV delete here, not 2
//     1  DO call releasing the cell slot
//        Reaps are budgeted separately rather than folded
//        into the per-push term: without their own ceiling
//        every one of the 34 pushes could reap, and the
//        deletes come out of a daily allowance the tick has
//        no other way to bound.
//
//   FIXED, independent of both counts:
//     1  KV list of `device:`                              readCoverage
//     1  KV list of `activity:`                            readActivityTokens
//     5  KV puts, MAX_TTL_MIGRATIONS_PER_TICK              migrateLegacyRecords
//     1  DO call                                           reconcileCoverage
//     1  DO call reading the pending-reap set              readPendingReaps
//   ---
//   223  = 9 + 34 x 6 + 2 x 5
//
//   223 + 600 per-device = 823 of 1,000 at the caps.
//
// The activity token deliberately costs one `list` for the whole tick rather
// than one `get` per device: it rides in the key's metadata (see
// readActivityTokens). Reading it per-device would make this 3 per device,
// 900 + 223 = 1,123, and would not fit.
//
// So the margin is roughly 18%, not the 3x that counting readCoverage alone
// suggests, and the real ceiling is under (1,000 - 223) / 2 = 388 device
// records — under, not at, because a tick that spends the 1,000th subrequest
// has no room for anything this model has not thought of, and the 1,001st
// throws "Too many subrequests" into the same per-grid catch the push budget
// exists to keep out of. The guardrail test asserts a strict inequality for
// that reason.
//
// The per-device and fixed halves are exported below so the guardrail test
// asserts this model rather than a figure that permits more devices than the
// budget really allows.
//
// Enforcing the push budget is not optional bookkeeping. Overrunning the 50
// makes the next fetch throw "Too many subrequests"; notifyOnce catches that
// and hands it to recordPushFailure, which returns early for anything that is
// not an APNsError — so the overrun would be swallowed, the tick would report
// success, and alerts would stop for an arbitrary, scheduling-order-dependent
// subset of users. createPushBudget below refuses deterministically instead,
// oldest cell first, and says so with console.error.
//
// WeatherKit quota cross-check — informative, not the binding constraint: the
// cron is `*/10 * * * *` (wrangler.toml), so it fires 144 times a day = 144 x
// 30.44 ~= 4,383 times a month, and 15 cells x 4,383 = 65,745 calls/month, 13%
// of the 500,000 Apple's Developer Program includes. The rest is left for the
// app's own on-device forecasts.
//
// The cap is set by the Free-plan subrequest budget, NOT by the WeatherKit
// quota. Note the two Free numbers are different ceilings on different things:
// 50 EXTERNAL subrequests per invocation, and a separate 1,000 for internal
// Cloudflare services (KV, Durable Objects). Raising the cap means moving to
// the Workers Paid plan — which raises the EXTERNAL limit to 10,000 per
// invocation by default, configurable up to 10 million via `limits.subrequests`
// — and re-running every line of arithmetic above. Free is what applies to this
// account.
export const MAX_GRID_CELLS = 15;
export const PUSH_BUDGET_PER_INVOCATION = 34;
export const MAX_DEVICES_PER_CELL = 20;

/** The most `device:` records one cron tick will read, = MAX_GRID_CELLS x MAX_DEVICES_PER_CELL. */
export const MAX_DEVICE_RECORDS = MAX_GRID_CELLS * MAX_DEVICES_PER_CELL;

// ---------------------------------------------------------------------------
// The registration throttle
// ---------------------------------------------------------------------------

// The app registers on cold launch, on every foreground, at the end of every
// successful weather poll, and on any move over 10 km. `/register-activity`
// draws on the same per-IP bucket.
//
// 20 per 10 minutes does NOT leave all of that untouched, and it is worth being
// plain about that rather than claiming headroom the foreground trigger spent:
// someone who flips into the app twenty times in ten minutes will throttle
// themselves, and a busy household or carrier-NAT block behind one egress IP
// reaches it sooner. The limit is kept anyway because the consequence is benign
// and self-healing — the 429 is raised by guardMutation before any stored state
// is touched, so it changes nothing, and the next foreground simply retries.
// The one case that is not self-healing is a brand-new user whose very first
// registration is refused: they get no alerts until they open the app again,
// with no UI signal, because surfacing throttle state was deliberately left out.
//
// Cutting the observed attack (250 registrations in 0.47s from one client) off
// after the first 20 is what this number is for.
export const RATE_LIMIT_WINDOW_SECONDS = 600;
export const RATE_LIMIT_MAX_REQUESTS = 20;

// How long a `device:` record survives without being refreshed. Renewal is not
// incidental: ContentView re-registers on cold launch, unconditionally on
// willEnterForeground, and after every successful weather poll, and
// LocationService re-registers on any move over 10 km — so a live install
// rewrites its own record long before 45 days pass, while a fabricated one,
// which nothing ever refreshes, evaporates. Before this existed the only
// pruning path was a push failure, which never fires for a coordinate where it
// never rains — which is why planted registrations used to be permanent.
export const DEVICE_RECORD_TTL_SECONDS = 45 * 24 * 60 * 60; // 45 days

// Records written before the TTL existed carry no expiration and KV cannot add
// one after the fact, so the cron rewrites them as it meets them. Bounded per
// tick because the Free plan allows 1,000 KV writes a day and this shares that
// budget: 5 x 144 ticks = 720/day even in the pathological case where the
// supply never runs out. It does run out — every writer goes through
// putDeviceRecord, so a migrated record is never seen again.
export const MAX_TTL_MIGRATIONS_PER_TICK = 5;

// How many dead devices one cron tick may reap. Bounded for the same reason
// MAX_TTL_MIGRATIONS_PER_TICK is: a reap is 2 KV deletes, and the Free plan
// allows 1,000 deletes a day across the namespace — a separate allowance from
// the 1,000 writes. Unbounded, a tick could reap once per push attempted, so
// 34 x 2 x 144 = 9,792 deletes a day, ten times the allowance.
//
// 2 x 2 x 144 = 576/day is the ceiling this sets, and it is only reached if
// every tick for a whole day finds two dead tokens — 288 devices churning
// daily against a 300-device cap. Deferring the rest is safe and now costs no
// pushes either: a deferred token is flagged pending-reap in the registry and
// the push loop skips it, and the next tick drains the queue at this same rate
// rather than losing it. The cost of deferral is only that the record sits in
// KV, holding its cell slot, until its turn comes.
export const MAX_DEVICE_REAPS_PER_TICK = 2;

// How stale a record may get before a re-registration rewrites it even though
// nothing in it changed. The client re-registers constantly (cold launch, every
// foreground, every successful poll), and writing on each of those spends the
// daily KV write allowance below on nothing. Skipping the identical write is
// only safe because this threshold forces one through long before the 45-day
// TTL runs out: 7 days leaves better than six refreshes of headroom.
//
// The freshness check reads `renewedAt`, never `registeredAt`. They are
// different facts: `registeredAt` is first-seen and must stay first-seen,
// because selectCellsWithinCap ranks cells by it and restamping it would let a
// planted record outrank a live user.
export const DEVICE_RECORD_REFRESH_SECONDS = 7 * 24 * 60 * 60; // 7 days

// The shortest interval at which one device's record may be re-persisted.
//
// It applies to SAME-CELL settings changes only. A registration whose grid key
// differs from the stored one is persisted immediately, never deferred: a
// device that moved keeps being alerted for the cell it left until its new
// coordinates land, and a mover silently warned about the wrong area is the
// exact product break this whole change exists to prevent. That outranks the
// write-budget bound, and the header above concedes the bound rather than
// pretending this closes it.
//
// So be plain about what is left. The adversarial drain the cooldown was
// reaching for — alternating one token between two grid cells, a genuine change
// every time, at the throttle's 20 per 10 minutes, i.e. 2,880 `device:` puts a
// day from one address against a 1,000-a-day allowance — is NOT bounded by this
// constant, because those are cell changes and cell changes always write. What
// this does bound is same-cell settings churn: at most 1,440/5 = 288 writes a
// day per device from repeated leadTimeMinutes / rainStartEnabled / rainEndEnabled
// flips, which is otherwise the same unbounded shape.
//
// The hardening deliberately not taken, kept here so it stays discoverable: an
// explicit deferral protocol — 202 with `deferred: true` and a
// `retryAfterSeconds`, plus a client that records a location only after the
// server confirms it stored it — would make deferring a cell change safe,
// because the move would be retried rather than silently dropped. Worth
// building if the drain ever appears in real traffic; not worth the client
// change on a fleet of single-digit devices today.
//
// 5 rather than 10 minutes because a deferred settings change is invisible to
// the user until it lands, and the client re-registers after every successful
// poll, so a shorter window costs nothing and heals sooner.
//
// This must never suppress a refresh-due write. Refresh-due (renewedAt older
// than DEVICE_RECORD_REFRESH_SECONDS) and cooling-down (renewedAt newer than
// this) read the same field for opposite purposes, and the TTL guarantee
// outranks the budget: writeDecision in index.ts checks refresh-due first.
export const DEVICE_REWRITE_COOLDOWN_SECONDS = 5 * 60; // 5 minutes

// ---------------------------------------------------------------------------
// Internal subrequests per tick — the model the guardrail test asserts
// ---------------------------------------------------------------------------

/** Every device record costs a readCoverage get plus a `notified-*` dedup get. */
export const INTERNAL_SUBREQUESTS_PER_DEVICE = 2;

/**
 * The worst case per push actually attempted: the `notified-*` dedup put, plus
 * recordPushFailure taking a BadDeviceToken strike (1 get + 1 put), plus the DO
 * call that flags a rejected token for reaping, plus a terminal Live Activity's
 * get-then-delete. Bounded by
 * PUSH_BUDGET_PER_INVOCATION, so this is fixed traffic, not per-device — which
 * is exactly why it belongs in the term below rather than being left out of the
 * model as happy-path-only.
 */
const INTERNAL_SUBREQUESTS_PER_PUSH_WORST_CASE = 6;

/**
 * removeDevice: 1 get + 1 delete on `device:`, clearActivityToken's 1 get and
 * (only for a device that held one) 1 delete, and 1 DO release.
 */
const INTERNAL_SUBREQUESTS_PER_REAP = 5;

/** The tick's device-count-independent internal traffic. */
export const INTERNAL_SUBREQUESTS_PER_TICK_FIXED =
  2 + // one KV list for `device:`, one for `activity:`
  MAX_TTL_MIGRATIONS_PER_TICK +
  1 + // the reconcile DO call
  1 + // the pending-reap DO read
  PUSH_BUDGET_PER_INVOCATION * INTERNAL_SUBREQUESTS_PER_PUSH_WORST_CASE +
  MAX_DEVICE_REAPS_PER_TICK * INTERNAL_SUBREQUESTS_PER_REAP;

/** Free-plan internal subrequests per invocation. */
export const INTERNAL_SUBREQUEST_CEILING = 1_000;

// ---------------------------------------------------------------------------
// The daily allowances — four KV buckets and three Durable Object meters
// ---------------------------------------------------------------------------

// Different budget, different period, and — the part that is easy to get wrong
// — SEVEN independent allowances, not one. The Free plan gives the KV namespace
// 100,000 key reads, 1,000 key writes, 1,000 key DELETES and 1,000 LIST
// requests per day, and meters Durable Objects again on top of that: 100,000
// requests, 100,000 SQLite rows WRITTEN and 5,000,000 rows read per day, plus
// 13,000 GB-s of duration. Writes and deletes do not share a pool, so a
// delete-driven amplifier cannot be reasoned about against the write budget;
// KV and the Durable Objects share nothing at all, so moving the gate's
// counters out of KV did not make them free — it moved them onto meters of
// their own, which is why they are counted here. Everything in the section
// above is per-invocation and says nothing about any of these.
//
// Counted at the caps (15 x 20 = 300 devices, 144 ticks/day):
//
// READS — 100,000/day
//   cron, per device record       2 x 300 x 144 = 86,400. The readCoverage get
//                                 plus the `notified-*` dedup get.
//   cron, per push attempted      <= 2 x 34 x 144 = 9,792. The `apnsfail:` get
//                                 and clearActivityToken's guard get.
//   cron, per reap               <= 2 x 144 = 288, removeDevice's guard get.
//   /register                     1 per request. The client registers on cold
//                                 launch, every foreground, every successful
//                                 poll and every >10 km move, so this is the
//                                 term that scales with user activity rather
//                                 than fleet size.
//   /unregister, /unregister-*    1 per request, the guard get.
//   => ~96,500 of 100,000 before a single registration, so /register reads are
//      what push it over. Note this is a deliberately pessimistic ceiling: it
//      assumes rain in every one of the 15 cells for all 144 ticks and a full
//      300-device fleet. Real load is single-digit devices, three orders of
//      magnitude below it.
//
// WRITES — 1,000/day
//   `device:` puts, /register     ~43/day steady state. Without the
//                                 skip-when-unchanged check below this would be
//                                 one write per foreground per device —
//                                 thousands. With it, an unchanged device
//                                 writes once per DEVICE_RECORD_REFRESH_SECONDS,
//                                 so 300/7 ~= 43, plus one per genuine change of
//                                 coordinates or settings.
//   `device:` puts, TTL migration <= 5 x 144 = 720/day, but only until the
//                                 pre-TTL records are drained; then zero.
//   `notified-*` dedup puts       <= PUSH_BUDGET_PER_INVOCATION x 144 = 4,896/day
//                                 at the absolute worst, one per push sent.
//   `apnsfail:` puts              <= one per rejected push, same ceiling.
//   `device:` puts, adversarial   <= 20 x 144 = 2,880/day per address, bounded
//                                 only by the per-client throttle. Moving a
//                                 token between two cells is a real change, so
//                                 the skip-when-unchanged check cannot see it;
//                                 it adds no cell and no record, so neither cap
//                                 sees it either; and a cell change is never
//                                 deferred, so DEVICE_REWRITE_COOLDOWN_SECONDS
//                                 does not see it either — that exemption is
//                                 deliberate, because deferring a real move
//                                 silently alerts the user for the wrong area.
//                                 The cooldown bounds only same-cell settings
//                                 churn, at 288/day per device. This term is why
//                                 the header above no longer calls registration
//                                 bounded.
//   `activity:` puts              1 per Live Activity started.
//   => Does NOT fit at the caps. Two separate terms exceed the allowance on
//      their own: at a full 300-device fleet the dedup put does — roughly
//      1,000/144 ~= 7 alerts per tick sustained around the clock is the whole
//      day's allowance, about 20 devices alerted continuously at the 30-minute
//      dedup interval — and with no fleet at all a single throttled address
//      does, via the adversarial rewrite term above. Exhausting it means
//      putDeviceRecord throws, so /register 500s for every real user, and
//      notifyOnce's dedup put throws after a successful send, so a raining cell
//      re-alerts every 10 minutes until 00:00 UTC.
//
// DELETES — 1,000/day, a SEPARATE allowance from writes
//   cron reaps                    <= MAX_DEVICE_REAPS_PER_TICK x 2 x 144 = 576/day,
//                                 and half that for the common device that
//                                 never started a Live Activity, since
//                                 clearActivityToken only deletes a key that
//                                 is actually there.
//                                 This is the one term the tick can bound by
//                                 itself, and MAX_DEVICE_REAPS_PER_TICK exists
//                                 to bound it; unbounded it would be 9,792.
//   cron clearActivityToken       1 per Live Activity that ends. Spikes at 34 in
//                                 one tick, but a device holds one activity at a
//                                 time and the key is gone once cleared, so the
//                                 sustained rate is bounded by activities ended,
//                                 not by the push budget.
//   /unregister                   2 per real teardown, 0 for a token that was
//                                 never registered.
//   /unregister-activity          1 per real teardown, 0 otherwise.
//   capacity refusal              2, and only when the caller really had a record.
//   => Fits only because every consumer is either budgeted or earned by a
//      stored record. Both of those are load-bearing, not tidiness: an
//      unconditional teardown on the deliberately unthrottled `/unregister`
//      would let one IP inside the 20-per-10-minutes registration throttle
//      spend the whole day's deletes in under two hours, after which every
//      `env.DEVICES.delete` fails until 00:00 UTC.
//
// LISTS — 1,000/day
//   cron                          2 x 144 = 288/day, the `device:` and
//                                 `activity:` prefix lists. That is per PAGE:
//                                 KV returns up to 1,000 keys per call, so at
//                                 the caps (300 + 300 keys) one call each
//                                 suffices, but a namespace holding more than
//                                 1,000 keys of either prefix multiplies this by
//                                 the page count.
//   => Fits with room, and is the only KV bucket that does.
//
// DO REQUESTS — 100,000/day, counting every call into an object and every alarm
//   /register                     1 for the throttle check, which every request
//                                 pays, plus 1 for the reserve — 2 for an
//                                 admitted registration, 1 for a 429, which
//                                 stops at the limiter.
//   /register-activity            1, the same throttle check. It writes only the
//                                 `activity:` key and never calls coverage.
//   /unregister                   1, the release, and only when the caller
//                                 really had a record. Deliberately unthrottled,
//                                 so there is no limiter call.
//   /unregister-activity          0. It reaches neither object.
//   cron                          <= 38/tick = 5,472/day: 1 pending-reaps read,
//                                 1 reconcile, MAX_DEVICE_REAPS_PER_TICK
//                                 releases, and worst case one flag-reap per
//                                 push attempted.
//   limiter alarms                1 per address per idle window, the self-clean.
//   => The cron spends ~5.5% of the allowance. Registration is the term that
//      moves: one address at the 20-per-10-minutes ceiling is 2,880
//      registrations = ~5,760 requests/day, so ~17 sustained addresses drain it.
//      And the throttle does not floor that: the throttle IS a DO call, so a
//      pure 429 flood still spends one DO request per HTTP request, one for one,
//      with nothing in this file bounding it.
//
// DO ROWS WRITTEN — 100,000/day; a put, a delete and a setAlarm are one row each
//   limiter, admitted request     1 WINDOW_KEY put, plus 1 setAlarm on the
//                                 request that opens a window and 1 for the
//                                 deleteAll when that alarm fires. A 429 writes
//                                 nothing at all.
//   reserve, per registration     1 RECENT_KEY put always, 1 COVERAGE_KEY put
//                                 when the tally actually moves, and 1
//                                 PENDING_KEY put only for a device that was
//                                 flagged — 1 to 3, usually 2.
//   reserve, per refusal          <= 2: the coverage put for the old cell it
//                                 released on the way in, and the
//                                 recent-admission forget.
//   release                       <= 3, on a teardown and on a reap.
//   flag-reap                     1 per newly rejected token, <= 34/tick.
//   reconcile                     3/tick unconditionally: coverage, recent,
//                                 pending.
//   => The cron is <= 43/tick = 6,192/day, ~6%. One address at the throttle
//      ceiling writes ~5,800 rows/day re-registering unchanged, and ~8,640 when
//      it alternates cells so the tally moves on every request, so 12 to 17
//      sustained addresses drain it — the same shape as the KV write bucket, and
//      for the same reason.
//
// DO ROWS READ — 5,000,000/day
//   ~4 per admitted registration (the limiter's window get, plus coverage,
//   recent and pending inside reserve) and ~45 per cron tick, so ~11,500/day
//   for an address at the throttle ceiling and ~6,500/day for the cron. Fits
//   with three orders of magnitude to spare. It is listed so the next reader can
//   see it was counted, not because it needs watching.
//
// DO DURATION — 13,000 GB-s/day
//   The one term here bounded by argument rather than arithmetic: neither object
//   holds a WebSocket or an outbound connection, so both are eligible to
//   hibernate between requests, and each request is a handful of storage
//   operations measured in milliseconds.
//
// So two of the four KV buckets do not fit at MAX_GRID_CELLS x
// MAX_DEVICES_PER_CELL, and the two are not alike — do not read one argument as
// covering both.
//
//   The WRITE bucket is NOT tunable here. Lowering MAX_DEVICES_PER_CELL does
//   not touch the dedup put, which is one per alert delivered, and lowering
//   PUSH_BUDGET_PER_INVOCATION would buy the write budget by dropping alerts
//   the per-invocation budget can afford to send. It is a genuine fleet-size
//   ceiling.
//
//   The READ bucket IS tunable here, and by exactly the constant above. Its
//   dominant term is 2 x MAX_GRID_CELLS x MAX_DEVICES_PER_CELL x 144, i.e.
//   86,400 of the 100,000 daily reads — about 86% — at MAX_DEVICES_PER_CELL =
//   20, and roughly 53,000 at 10, which would leave room for registrations.
//   MAX_DEVICES_PER_CELL is deliberately left at 20 anyway: 86,400 is the
//   theoretical maximum-fleet ceiling, not current load, and real traffic is
//   single-digit devices. Anyone approaching the caps for real should lower it
//   rather than assume the bucket cannot move.
//
//   BOTH DO METERS FIT, and neither gets a budget. Legitimate traffic spends
//   about 6% of each, and no arithmetic above asks for a bound, so there is
//   deliberately no per-tick DO budget, no new constant and no guard code here —
//   a mitigation nothing demands is just another thing to get wrong. What does
//   need saying is the failure mode, because it is unlike KV's: both callers
//   fail OPEN on purpose (checkRegistrationRate at the throttle, reserveGridCell
//   at the caps — see intent decision 4), so exhausting a DO meter does not
//   refuse registrations, it switches the throttle and both caps off until 00:00
//   UTC behind a single console.warn. What still bounds the damage in that
//   window is selectCellsWithinCap, which truncates the cron's fan-out whatever
//   the registry says, and the 1,000 daily KV writes, which cap how many records
//   can be planted at all.
//
// The honest statement is that these caps are sized for the current fleet
// (TESTING.md documents ~15 devices, an order of magnitude below every
// crossover above) and that running near the caps needs the Paid plan.
// Exceeding an allowance makes that operation fail for the rest of the UTC day:
// KV writes gone means putDeviceRecord throws and /register 500s, and the 45-day
// TTL is only safe while live installs can renew; KV deletes gone means
// /unregister 500s and dead tokens cannot be reaped; a DO meter gone means the
// gate stops counting and lets everything through.

// ---------------------------------------------------------------------------
// Client identity
// ---------------------------------------------------------------------------

// `CF-Connecting-IP` is written by Cloudflare's edge on every request and
// overwrites whatever the client sent, so it cannot be forged from outside.
// When it is absent - `wrangler dev`, or a unit test - everything shares one
// bucket, which throttles harder rather than softer.
function clientAddress(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

// The address is hashed before it names a Durable Object so that the instance
// name is not a short-lived log of who talked to us. This is bookkeeping
// hygiene, not anonymisation: the IPv4 space is small enough to brute-force a
// hash.
async function clientBucket(request: Request): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(clientAddress(request))
  );
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Rate limit
// ---------------------------------------------------------------------------

export async function checkRegistrationRate(request: Request, env: Env): Promise<RateDecision> {
  const bucket = await clientBucket(request);

  try {
    const stub = env.REGISTRATION_LIMITER.get(env.REGISTRATION_LIMITER.idFromName(bucket));
    const response = await stub.fetch('https://limiter/check', {
      method: 'POST',
      body: JSON.stringify({
        windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
        maxRequests: RATE_LIMIT_MAX_REQUESTS,
      }),
    });
    return (await response.json()) as RateReply;
  } catch (err) {
    // An infrastructure blip must not lock every real user out of registering.
    // Failing open here cannot uncap the expensive thing: the coverage registry
    // is a separate object, and selectCellsWithinCap bounds the cron's fan-out
    // no matter what the registration side let through.
    console.warn(`[Abuse] Rate-limit bookkeeping failed, allowing request: ${err}`);
    return { ok: true, retryAfterSeconds: 0 };
  }
}

export type RateDecision = RateReply;
export type CellDecision = CoverageReply;

// ---------------------------------------------------------------------------
// Coverage caps
// ---------------------------------------------------------------------------

/**
 * Admits a device into `gridKey`, enforcing MAX_GRID_CELLS and
 * MAX_DEVICES_PER_CELL against the strongly consistent tally in
 * CoverageRegistry.
 *
 * A device already registered in that cell is always admitted — existing users
 * can re-register, move within their cell, or change their lead time even once
 * the service is full. Only a device that is new to a full cell, or that would
 * open a cell beyond the global cap (and so add ~4,383 WeatherKit calls a
 * month, forever), is turned away.
 */
export async function reserveGridCell(
  gridKey: string,
  deviceToken: string,
  env: Env,
  options: { incumbent?: boolean } = {}
): Promise<CellDecision> {
  try {
    const response = await coverageStub(env).fetch('https://coverage/reserve', {
      method: 'POST',
      body: JSON.stringify({
        gridKey,
        deviceToken,
        incumbent: options.incumbent === true,
        maxCells: MAX_GRID_CELLS,
        maxDevicesPerCell: MAX_DEVICES_PER_CELL,
      }),
    });
    return (await response.json()) as CoverageReply;
  } catch (err) {
    // As with the throttle: prefer a working service over a strictly-accounted
    // one. selectCellsWithinCap is what actually protects the quota.
    console.warn(`[Abuse] Grid-cell bookkeeping failed, allowing registration: ${err}`);
    return { ok: true, cells: 0, devices: 0 };
  }
}

/**
 * Queues a rejected token for deletion and drops it out of the push rotation.
 *
 * Fails open: a flag that does not stick costs one wasted push next tick, while
 * throwing here would take down the alert loop this exists to protect.
 */
export async function flagPendingReap(deviceToken: string, env: Env): Promise<void> {
  try {
    await coverageStub(env).fetch('https://coverage/flag-reap', {
      method: 'POST',
      body: JSON.stringify({ deviceToken }),
    });
  } catch (err) {
    console.warn(`[Abuse] Could not flag device for reaping: ${err}`);
  }
}

/**
 * The tokens this tick must skip, because APNs already rejected them and they
 * are only waiting on the reap budget. One DO call for the whole tick.
 *
 * Fails open to an empty set: skipping is an optimisation for the push budget,
 * never a correctness requirement, so a registry blip must not stop alerts.
 */
export async function readPendingReaps(env: Env): Promise<Set<string>> {
  try {
    const res = await coverageStub(env).fetch('https://coverage/pending-reaps', { method: 'POST' });
    const { tokens } = (await res.json()) as { tokens: string[] };
    return new Set(tokens);
  } catch (err) {
    console.warn(`[Abuse] Could not read pending reaps: ${err}`);
    return new Set();
  }
}

/** Frees the cell slot a device holds. Every path that drops a `device:` record calls this. */
export async function releaseGridCell(deviceToken: string, env: Env): Promise<void> {
  try {
    await coverageStub(env).fetch('https://coverage/release', {
      method: 'POST',
      body: JSON.stringify({ deviceToken }),
    });
  } catch (err) {
    console.warn(`[Abuse] Could not release grid-cell slot: ${err}`);
  }
}

/**
 * Truth-up: hands the registry what KV actually holds, once per cron tick.
 *
 * Device records expire on their own TTL and nothing tells the registry, so
 * without this the tally would only ever grow and would eventually refuse real
 * users on behalf of cells that no longer exist.
 */
export async function reconcileCoverage(grids: GridCell[], env: Env): Promise<void> {
  const coverage: CoverageMap = {};
  for (const grid of grids) {
    coverage[grid.gridKey] = grid.devices.map((device) => device.token);
  }

  try {
    await coverageStub(env).fetch('https://coverage/reconcile', {
      method: 'POST',
      body: JSON.stringify({ coverage }),
    });
  } catch (err) {
    console.warn(`[Abuse] Could not reconcile grid-cell coverage: ${err}`);
  }
}

function coverageStub(env: Env): DurableObjectStub {
  return env.COVERAGE.get(env.COVERAGE.idFromName('global'));
}

// ---------------------------------------------------------------------------
// Per-tick budgets
// ---------------------------------------------------------------------------

export interface TickBudget {
  /** Claims one unit. False means the budget is gone and nothing was done. */
  spend(): boolean;
  /** Units claimed so far. */
  readonly spent: number;
  /** Units refused because the budget was exhausted. */
  readonly denied: number;
}

export function createPushBudget(limit = PUSH_BUDGET_PER_INVOCATION): TickBudget {
  let spent = 0;
  let denied = 0;
  return {
    spend(): boolean {
      if (spent >= limit) {
        denied += 1;
        return false;
      }
      spent += 1;
      return true;
    },
    get spent() {
      return spent;
    },
    get denied() {
      return denied;
    },
  };
}

// ---------------------------------------------------------------------------
// Cron-side cap
// ---------------------------------------------------------------------------

/** Ascending by `registeredAt`, ties broken on token so the order is total. */
function byFirstSeen(a: DeviceRegistration, b: DeviceRegistration): number {
  if (a.registeredAt !== b.registeredAt) return a.registeredAt < b.registeredAt ? -1 : 1;
  if (a.token === b.token) return 0;
  return a.token < b.token ? -1 : 1;
}

/**
 * Puts the cron's whole work list into first-seen order, oldest first, and
 * truncates it to MAX_GRID_CELLS.
 *
 * The truncation is the caps' last line of defence: whatever ends up in KV, the
 * cron never fans out to more than MAX_GRID_CELLS cells in one invocation, which
 * keeps the Free plan's external-subrequest ceiling out of reach even if the
 * registration side is raced, mis-counted, or bypassed entirely.
 *
 * The ordering matters just as much, and it is applied unconditionally — not
 * only when the list is long enough to truncate. PUSH_BUDGET_PER_INVOCATION can
 * bind well below the cell cap (ten cells of four devices already want more
 * pushes than a tick can afford), and whoever the loop reaches last is who goes
 * unnotified. Left in KV list order that would be `device:<token-hex>` order:
 * arbitrary with respect to who was here first, and *stable*, so the same
 * devices would lose their pushes on every tick forever. Sorting devices inside
 * each cell as well as the cells themselves makes budget exhaustion fall on the
 * newest arrivals instead, which is the same incumbent-protection promise the
 * cell truncation makes.
 *
 * Both orderings are only truthful because handleRegister preserves a device's
 * original `registeredAt` across re-registrations — restamping it would invert
 * the ranking, handing every slot to whoever registered least recently.
 */
export function selectCellsWithinCap(grids: GridCell[]): { cells: GridCell[]; skipped: number } {
  // Decorate-sort-undecorate: sorting each cell's devices first makes its oldest
  // registration simply the head of that list, so no cell is scanned twice.
  const ranked = grids
    .map((cell) => {
      const devices = [...cell.devices].sort(byFirstSeen);
      return {
        cell: { gridKey: cell.gridKey, devices },
        oldest: devices[0]?.registeredAt ?? '9999',
      };
    })
    .sort((a, b) => {
      if (a.oldest !== b.oldest) return a.oldest < b.oldest ? -1 : 1;
      if (a.cell.gridKey === b.cell.gridKey) return 0;
      return a.cell.gridKey < b.cell.gridKey ? -1 : 1;
    })
    .map((entry) => entry.cell);

  return {
    cells: ranked.slice(0, MAX_GRID_CELLS),
    skipped: Math.max(0, grids.length - MAX_GRID_CELLS),
  };
}

/** Bounds the KV deletes one tick spends reaping dead device tokens. */
export function createReapBudget(limit = MAX_DEVICE_REAPS_PER_TICK): TickBudget {
  return createPushBudget(limit);
}
