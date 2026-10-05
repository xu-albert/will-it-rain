// Every other suite imports the Worker's TypeScript straight into Node, which
// accepts any module shape. workerd does not: it refuses to start a Worker whose
// main module has a named export that is neither a handler object nor a class
// (a numeric constant, say), and `wrangler deploy --dry-run` never executes the
// module, so nothing else here would notice. This boots the bundle in the local
// Workers runtime, as `wrangler dev` does, and sends it one registration.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { unstable_DevEnv } from 'wrangler';

it('starts in the Workers runtime and answers POST /register', async () => {
  // A fresh store each run, so the registration throttle never sees a past run.
  const persist = await mkdtemp(`${tmpdir()}/will-it-rain-runtime-`);
  const devEnv = new unstable_DevEnv();
  // A runtime that refuses the bundle is reported here; the worker's fetch
  // would otherwise wait on it until the test times out.
  const failed = new Promise<never>((_, reject) =>
    devEnv.on('error', (event: Error | { source: string; reason: string; cause?: unknown }) =>
      reject(
        event instanceof Error
          ? event
          : new Error(`${event.source}: ${event.reason}`, { cause: event.cause })
      )
    )
  );
  try {
    const worker = await devEnv.startWorker({
      config: 'wrangler.toml',
      sendMetrics: false,
      dev: {
        remote: false,
        persist,
        inspector: false,
        server: { hostname: '127.0.0.1', port: 0 },
        watch: false,
        logLevel: 'error',
      },
    });
    const response = await Promise.race([
      failed,
      worker.fetch('http://127.0.0.1/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: '0401'.repeat(16), lat: 37.77, lon: -122.41 }),
      }),
    ]);
    expect(response.status).toBe(200);
  } finally {
    await devEnv.teardown().finally(() => rm(persist, { recursive: true, force: true }));
  }
}, 60_000);
