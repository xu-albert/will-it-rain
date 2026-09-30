import { describe, expect, it, vi } from 'vitest';
import { fetchForecast } from '../src/weatherkit';
import { generateSigningKey, makeHarness } from './harness';

describe('WeatherKit authentication', () => {
  it('reuses a JWT for 40 minutes, then refreshes it', async () => {
    vi.useFakeTimers();
    const issuedAt = Date.parse('2026-01-01T12:00:00.000Z');
    vi.setSystemTime(new Date(issuedAt));

    const { env } = makeHarness({ signingKey: await generateSigningKey() });
    const authorization: string[] = [];
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorization.push(new Headers(init?.headers).get('Authorization') ?? '');
      return new Response('{}', { status: 200 });
    });

    try {
      await fetchForecast(37, -122, env);

      vi.setSystemTime(new Date(issuedAt + 39 * 60_000));
      await fetchForecast(37, -122, env);
      expect(authorization[1]).toBe(authorization[0]);

      vi.setSystemTime(new Date(issuedAt + 40 * 60_000));
      await fetchForecast(37, -122, env);
      expect(authorization[2]).not.toBe(authorization[1]);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
