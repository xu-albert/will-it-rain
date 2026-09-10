// CRON_PERIOD_MINUTES is a copy of the interval baked into wrangler.toml's cron
// expression, because Workers cron triggers have no runtime API to read the
// schedule back. This pins the two together: if wrangler.toml's expression
// changes, this test fails until CRON_PERIOD_MINUTES is updated to match.

import { describe, expect, it } from 'vitest';
import toml from '../wrangler.toml?raw';
import { CRON_PERIOD_MINUTES } from '../src/scheduling';

describe('CRON_PERIOD_MINUTES', () => {
  it('matches the interval in the wrangler.toml cron expression', () => {
    const match = toml.match(/crons\s*=\s*\[\s*"\*\/(\d+) \* \* \* \*"\s*\]/);
    expect(match, `Expected wrangler.toml to have a "*/N * * * *" cron expression, got:\n${toml}`).not.toBeNull();

    const periodFromToml = Number(match![1]);
    expect(CRON_PERIOD_MINUTES).toBe(periodFromToml);
  });
});
