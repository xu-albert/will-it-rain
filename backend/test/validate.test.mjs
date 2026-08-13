import assert from 'node:assert/strict';
import {
  isValidDeviceToken,
  isValidActivityToken,
  isValidLatitude,
  isValidLongitude,
  clampLeadTimeMinutes,
  asBoolean,
  secureEquals,
} from '../.test-build/validate.js';

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
};

const realDeviceToken = 'a'.repeat(64);
const realActivityToken = 'd9edb3' + 'f'.repeat(154) + '6301'; // 164 hex chars

check('accepts a 64-char hex device token', () => {
  assert.equal(isValidDeviceToken(realDeviceToken), true);
});
check('accepts every real production device token', () => {
  // The six tokens actually registered in KV as of 2026-07-27.
  const live = [
    '5b1fad1f37c3cc903a9298157019c8eb7c812dab97398b465e4e58c3103d9098',
    '5f25f5e767a0b089590175b4a7422b922a30e8021c19ebac69900fd9678c645f',
    '6ac030bf14d8a3400472a41ba1e8a173b8d63e2f3dba7e514a805e4c256d60ca',
    '837f78c77cbc51dc42c95195e79445d0a5e744e57e828a3990f7d24f9eb434a3',
    'abaa60831c36726ed64a804f629865f2c3e05209d31ae4c7162378a9133d058a',
    'd9edb3efe27d95ff3a960bba5f45b76202c1987e9eeb19555233f56da84b6301',
  ];
  for (const t of live) assert.equal(isValidDeviceToken(t), true, `rejected live token ${t.slice(0, 6)}…`);
});
check('device validator rejects an over-long token', () => {
  assert.equal(isValidDeviceToken('a'.repeat(129)), false);
});
check('activity validator accepts a long Live Activity token', () => {
  assert.equal(isValidActivityToken(realActivityToken), true);
});
check('activity validator accepts a device-length token', () => {
  assert.equal(isValidActivityToken(realDeviceToken), true);
});
check('activity validator still bounds length', () => {
  assert.equal(isValidActivityToken('a'.repeat(513)), false);
});
check('activity validator rejects non-hex', () => {
  assert.equal(isValidActivityToken('!'.repeat(100)), false);
});
check('accepts uppercase hex', () => {
  assert.equal(isValidDeviceToken('A'.repeat(64)), true);
});
check('rejects too-short token', () => {
  assert.equal(isValidDeviceToken('a'.repeat(63)), false);
});
check('rejects non-hex characters', () => {
  assert.equal(isValidDeviceToken('z'.repeat(64)), false);
});
check('rejects KV key injection attempt', () => {
  assert.equal(isValidDeviceToken('device:' + 'a'.repeat(57)), false);
});
check('rejects non-string tokens', () => {
  for (const bad of [undefined, null, 42, {}, [], true]) {
    assert.equal(isValidDeviceToken(bad), false, `accepted ${JSON.stringify(bad)}`);
  }
});

check('accepts in-range latitudes', () => {
  for (const v of [0, -90, 90, 37.3318, 54.6]) assert.equal(isValidLatitude(v), true, `rejected ${v}`);
});
check('rejects out-of-range latitude', () => {
  for (const v of [90.1, -90.1, 1000]) assert.equal(isValidLatitude(v), false, `accepted ${v}`);
});
check('rejects NaN/Infinity latitude', () => {
  for (const v of [NaN, Infinity, -Infinity]) assert.equal(isValidLatitude(v), false, `accepted ${v}`);
});
check('rejects string latitude', () => {
  assert.equal(isValidLatitude('37.3'), false);
});
check('accepts in-range longitudes', () => {
  for (const v of [0, -180, 180, -122.03, -5.93]) assert.equal(isValidLongitude(v), true, `rejected ${v}`);
});
check('rejects out-of-range longitude', () => {
  for (const v of [180.1, -180.1, NaN]) assert.equal(isValidLongitude(v), false, `accepted ${v}`);
});

check('clamps lead time to bounds', () => {
  assert.equal(clampLeadTimeMinutes(1), 5);
  assert.equal(clampLeadTimeMinutes(99999), 120);
  assert.equal(clampLeadTimeMinutes(-100), 5);
});
check('passes through valid lead times', () => {
  assert.equal(clampLeadTimeMinutes(20), 20);
  assert.equal(clampLeadTimeMinutes(60), 60);
});
check('rounds fractional lead time', () => {
  assert.equal(clampLeadTimeMinutes(20.6), 21);
});
check('defaults lead time for junk input', () => {
  for (const bad of [undefined, null, 'soon', NaN, {}]) {
    assert.equal(clampLeadTimeMinutes(bad), 20, `bad default for ${JSON.stringify(bad)}`);
  }
});

check('asBoolean keeps real booleans, defaults junk', () => {
  assert.equal(asBoolean(false, true), false);
  assert.equal(asBoolean(true, false), true);
  assert.equal(asBoolean('yes', true), true);
  assert.equal(asBoolean(undefined, false), false);
});

check('secureEquals matches identical strings', () => {
  assert.equal(secureEquals('s3cret-token', 's3cret-token'), true);
});
check('secureEquals rejects different strings of equal length', () => {
  assert.equal(secureEquals('s3cret-token', 's3cret-tokeX'), false);
});
check('secureEquals rejects different lengths', () => {
  assert.equal(secureEquals('short', 'longer-value'), false);
});
check('secureEquals rejects empty vs non-empty', () => {
  assert.equal(secureEquals('', 'x'), false);
});

console.log(`${passed} checks passed`);
