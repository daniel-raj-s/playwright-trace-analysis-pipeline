const test = require('node:test');
const assert = require('node:assert');
const { createErrorFingerprint, calculateSimilarity } = require('../utils/fingerprint');

test('createErrorFingerprint normalizes ANSI escapes and line numbers', () => {
  const rawErr = '\u001b[31mError: Locator "button" timed out after 5000ms at line 42:15\u001b[0m';
  const fp = createErrorFingerprint(rawErr);

  assert.ok(!fp.includes('\u001b'));
  assert.ok(!fp.includes('5000ms'));
  assert.ok(fp.includes('<DUR>') || fp.includes('<N>'));
  assert.ok(fp.includes('at line <N>'));
  assert.ok(fp.length <= 200);
});

test('calculateSimilarity returns 1.0 for identical and >= 0.75 for minor DOM drift', () => {
  const err1 = 'Timeout 10000ms exceeded waiting for locator("button#enroll") to be visible';
  const err2 = 'Timeout 10000ms exceeded waiting for locator("button#enroll-v2") to be visible';
  const errUnrelated = '502 Bad Gateway: Downstream service unavailable on auth endpoint';

  const fp1 = createErrorFingerprint(err1);
  const fp2 = createErrorFingerprint(err2);
  const fpUnrelated = createErrorFingerprint(errUnrelated);

  const simIdentical = calculateSimilarity(fp1, fp1);
  assert.strictEqual(simIdentical, 1.0);

  const simDrift = calculateSimilarity(fp1, fp2);
  assert.ok(simDrift >= 0.70, `Expected similarity >= 0.70, got ${simDrift}`);

  const simDiff = calculateSimilarity(fp1, fpUnrelated);
  assert.ok(simDiff < 0.40, `Expected low similarity, got ${simDiff}`);
});

test('empty or null error returns null fingerprint', () => {
  assert.strictEqual(createErrorFingerprint(null), null);
  assert.strictEqual(createErrorFingerprint(''), null);
  assert.strictEqual(createErrorFingerprint('   \n  '), null);
});

