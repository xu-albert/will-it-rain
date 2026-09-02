// The Worker under test, wired to in-memory KV and Durable Object stand-ins.
//
// Shared by every backend test file so they all exercise the same real fetch
// and scheduled handlers against the same real Durable Object classes — never a
// stub of the gate or the cron itself.

import { CoverageRegistry, RegistrationLimiter } from '../src/index';
import { Env } from '../src/types';
import { KVMock } from './kvMock';
import { DurableObjectNamespaceMock } from './doMock';

export interface Harness {
  env: Env;
  kv: KVMock;
  limiter: DurableObjectNamespaceMock;
  coverage: DurableObjectNamespaceMock;
}

export function makeHarness(
  options: { kv?: KVMock; failingDurableObjects?: boolean; signingKey?: string } = {}
): Harness {
  const kv = options.kv ?? new KVMock();
  const doOptions = { failing: options.failingDurableObjects };
  const limiter = new DurableObjectNamespaceMock(RegistrationLimiter, doOptions);
  const coverage = new DurableObjectNamespaceMock(CoverageRegistry, doOptions);

  const env: Env = {
    DEVICES: kv as unknown as KVNamespace,
    REGISTRATION_LIMITER: limiter as unknown as DurableObjectNamespace,
    COVERAGE: coverage as unknown as DurableObjectNamespace,
    APPLE_TEAM_ID: 'TEAMID',
    APPLE_KEY_ID: 'KEYID',
    APPLE_PRIVATE_KEY: options.signingKey ?? '',
    WEATHERKIT_SERVICE_ID: 'service',
    APNS_TOPIC: 'topic',
    APNS_ENV: 'sandbox',
  };

  return { env, kv, limiter, coverage };
}

/**
 * A throwaway P-256 private key as base64 PKCS#8, so the cron's JWT signing
 * actually succeeds and a tick can reach a real push. With APPLE_PRIVATE_KEY
 * empty, importKey throws and every grid dies in the per-grid catch long before
 * any push is attempted.
 */
export async function generateSigningKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer;
  return btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
}

/** A syntactically valid — and entirely fabricated — 64-char hex device token. */
export function fakeToken(n: number): string {
  return n.toString(16).padStart(4, '0').repeat(16);
}

/** Distinct coordinates 0.05 deg apart, so each maps to its own grid cell. */
export function coordsForCell(n: number): { lat: number; lon: number } {
  return { lat: 30 + (n % 200) * 0.05, lon: -120 - Math.floor(n / 200) * 0.05 };
}
