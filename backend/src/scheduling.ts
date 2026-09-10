// The cron's own tick period, as a single source of truth for gates that need
// to reason about how far apart ticks land.
//
// Keep in sync with the `crons` expression in `wrangler.toml`
// (`scheduling.test.ts` fails the build if they drift).
export const CRON_PERIOD_MINUTES = 10;
