// The cron's own tick period, as a single source of truth for gates that need
// to reason about how far apart ticks land.
//
// Keep in sync with the `crons` expression in `wrangler.toml`: a Workers cron
// trigger exposes no schedule the Worker can read back, so this is the only
// place the period is known in code.
export const CRON_PERIOD_MINUTES = 10;
