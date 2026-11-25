import { describe, expect, it, vi } from 'vitest';
import { fetchForecast, WEATHERKIT_TIMEOUT_MS } from '../src/weatherkit';
import {
  APNS_TIMEOUT_MS,
  LIVE_ACTIVITY_PRIORITY,
  sendLiveActivityUpdate,
  sendRainAlert,
} from '../src/apns';
import { fakeToken, generateSigningKey, makeHarness } from './harness';

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

describe('Upstream fetch timeouts', () => {
  function hungFetch(seenSignals: Array<AbortSignal | null | undefined>) {
    return (_input: RequestInfo | URL, init?: RequestInit) => {
      seenSignals.push(init?.signal);
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    };
  }

  function fastTimeoutSpy() {
    // Node's native AbortSignal.timeout uses an internal timer outside vi.useFakeTimers,
    // so spy on it to verify the exact millisecond budget while aborting quickly.
    return vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
        10
      );
      return controller.signal;
    });
  }

  it('aborts a stalled WeatherKit fetch at WEATHERKIT_TIMEOUT_MS', async () => {
    const { env } = makeHarness({ signingKey: await generateSigningKey() });
    const signals: Array<AbortSignal | null | undefined> = [];
    const timeoutSpy = fastTimeoutSpy();
    vi.stubGlobal('fetch', hungFetch(signals));

    try {
      expect(WEATHERKIT_TIMEOUT_MS).toBe(8_000);
      await expect(fetchForecast(37.35, -122.05, env)).rejects.toThrow(/timed out|aborted/i);
      expect(timeoutSpy).toHaveBeenCalledWith(WEATHERKIT_TIMEOUT_MS);
      expect(signals).toHaveLength(1);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      expect(signals[0]?.aborted).toBe(true);
    } finally {
      timeoutSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('aborts stalled APNs alert and Live Activity fetches at APNS_TIMEOUT_MS', async () => {
    const { env } = makeHarness({ signingKey: await generateSigningKey() });
    const signals: Array<AbortSignal | null | undefined> = [];
    const timeoutSpy = fastTimeoutSpy();
    vi.stubGlobal('fetch', hungFetch(signals));

    try {
      expect(APNS_TIMEOUT_MS).toBe(8_000);

      await expect(sendRainAlert(fakeToken(1), 10, env)).rejects.toThrow(/timed out|aborted/i);

      await expect(
        sendLiveActivityUpdate(
          fakeToken(2),
          {
            statusText: 'Rain incoming',
            countdownTarget: null,
            heroText: null,
            subBold: 'Rain expected',
            subRest: ' · next hour',
            boldFirst: true,
            rightText: '',
            segments: [],
            windowMinutes: 90,
            midLabel: '+45 min',
            endLabel: '+90 min',
            flagText: null,
            flagPosition: null,
            precip: 'rain',
          },
          env,
          { event: 'update', priority: LIVE_ACTIVITY_PRIORITY.transition }
        )
      ).rejects.toThrow(/timed out|aborted/i);

      expect(timeoutSpy).toHaveBeenCalledTimes(2);
      expect(timeoutSpy).toHaveBeenNthCalledWith(1, APNS_TIMEOUT_MS);
      expect(timeoutSpy).toHaveBeenNthCalledWith(2, APNS_TIMEOUT_MS);
      expect(signals).toHaveLength(2);
      expect(signals.every((s) => s instanceof AbortSignal && s.aborted)).toBe(true);
    } finally {
      timeoutSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
