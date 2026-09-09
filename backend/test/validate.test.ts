// Direct unit cases for each validator in validate.ts.
//
// Before this file the validators were exercised only through /register in
// abuse.test.ts, which localises a failure to "registration rejected" rather
// than to the predicate that did it. Every token below is fabricated: the
// shape under test is "64 lowercase hex characters", which needs no real
// device to demonstrate, and a real APNs token identifies a real person's
// phone and pairs with their location in KV.

import { describe, expect, it } from 'vitest';
import {
  asBoolean,
  clampLeadTimeMinutes,
  isValidActivityToken,
  isValidDeviceToken,
  isValidLatitude,
  isValidLongitude,
  secureEquals,
} from '../src/validate';

const deviceToken = 'a'.repeat(64);
const activityToken = 'd9edb3' + 'f'.repeat(154) + '6301'; // 164 hex chars, the real length

/** Six synthetic tokens with the mixed-nibble look of real ones. */
const realisticTokens = Array.from({ length: 6 }, (_, n) =>
  Array.from({ length: 64 }, (_, i) => ((i * 7 + n * 13 + (i % 3) * 5) % 16).toString(16)).join('')
);

describe('device tokens', () => {
  it('accepts a 64-char hex token', () => {
    expect(isValidDeviceToken(deviceToken)).toBe(true);
  });

  it('accepts the mixed-nibble shape real production tokens have', () => {
    for (const t of realisticTokens) {
      expect(t).toHaveLength(64);
      expect(isValidDeviceToken(t)).toBe(true);
    }
    expect(new Set(realisticTokens).size).toBe(6);
  });

  it('accepts uppercase hex', () => {
    expect(isValidDeviceToken('A'.repeat(64))).toBe(true);
  });

  it('rejects an over-long token', () => {
    expect(isValidDeviceToken('a'.repeat(129))).toBe(false);
  });

  it('rejects a too-short token', () => {
    expect(isValidDeviceToken('a'.repeat(63))).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(isValidDeviceToken('z'.repeat(64))).toBe(false);
  });

  it('rejects a KV key injection attempt', () => {
    expect(isValidDeviceToken('device:' + 'a'.repeat(57))).toBe(false);
  });

  it('rejects non-string values', () => {
    for (const bad of [undefined, null, 42, {}, [], true]) {
      expect(isValidDeviceToken(bad), `accepted ${JSON.stringify(bad)}`).toBe(false);
    }
  });
});

describe('activity tokens', () => {
  it('accepts a full-length Live Activity token', () => {
    expect(isValidActivityToken(activityToken)).toBe(true);
  });

  it('accepts a device-length token', () => {
    expect(isValidActivityToken(deviceToken)).toBe(true);
  });

  it('still bounds the length', () => {
    expect(isValidActivityToken('a'.repeat(513))).toBe(false);
  });

  it('rejects non-hex', () => {
    expect(isValidActivityToken('!'.repeat(100))).toBe(false);
  });
});

describe('coordinates', () => {
  it('accepts in-range latitudes', () => {
    for (const v of [0, -90, 90, 37.3318, 54.6]) expect(isValidLatitude(v), `rejected ${v}`).toBe(true);
  });

  it('rejects out-of-range latitudes', () => {
    for (const v of [90.1, -90.1, 1000]) expect(isValidLatitude(v), `accepted ${v}`).toBe(false);
  });

  it('rejects NaN and infinite latitudes', () => {
    for (const v of [NaN, Infinity, -Infinity]) expect(isValidLatitude(v), `accepted ${v}`).toBe(false);
  });

  it('rejects a string latitude', () => {
    expect(isValidLatitude('37.3')).toBe(false);
  });

  it('accepts in-range longitudes', () => {
    for (const v of [0, -180, 180, -122.03, -5.93]) expect(isValidLongitude(v), `rejected ${v}`).toBe(true);
  });

  it('rejects out-of-range longitudes', () => {
    for (const v of [180.1, -180.1, NaN]) expect(isValidLongitude(v), `accepted ${v}`).toBe(false);
  });
});

describe('lead time', () => {
  it('clamps to the bounds', () => {
    expect(clampLeadTimeMinutes(1)).toBe(5);
    expect(clampLeadTimeMinutes(99999)).toBe(120);
    expect(clampLeadTimeMinutes(-100)).toBe(5);
  });

  it('passes through valid values', () => {
    expect(clampLeadTimeMinutes(20)).toBe(20);
    expect(clampLeadTimeMinutes(60)).toBe(60);
  });

  it('rounds a fractional value', () => {
    expect(clampLeadTimeMinutes(20.6)).toBe(21);
  });

  it('defaults junk input', () => {
    for (const bad of [undefined, null, 'soon', NaN, {}]) {
      expect(clampLeadTimeMinutes(bad), `bad default for ${JSON.stringify(bad)}`).toBe(20);
    }
  });
});

describe('asBoolean', () => {
  it('keeps real booleans and defaults everything else', () => {
    expect(asBoolean(false, true)).toBe(false);
    expect(asBoolean(true, false)).toBe(true);
    expect(asBoolean('yes', true)).toBe(true);
    expect(asBoolean(undefined, false)).toBe(false);
  });
});

describe('secureEquals', () => {
  it('matches identical strings', () => {
    expect(secureEquals('s3cret-token', 's3cret-token')).toBe(true);
  });

  it('rejects different strings of equal length', () => {
    expect(secureEquals('s3cret-token', 's3cret-tokeX')).toBe(false);
  });

  it('rejects different lengths', () => {
    expect(secureEquals('short', 'longer-value')).toBe(false);
  });

  it('rejects empty against non-empty', () => {
    expect(secureEquals('', 'x')).toBe(false);
  });
});
