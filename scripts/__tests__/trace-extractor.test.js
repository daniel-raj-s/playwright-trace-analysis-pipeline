const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { extractFailures } = require('../trace/extract-trace-failures');
const { createSampleTraceZip } = require('./fixtures/generate-fixture');

test('extractFailures accurately extracts failed actions, network errors, and filters noise', () => {
  const tmpDir = path.join(__dirname, 'tmp_trace_test');
  fs.mkdirSync(tmpDir, { recursive: true });

  const traceZipPath = path.join(tmpDir, 'sample-trace.zip');
  createSampleTraceZip(traceZipPath);

  const outDir = path.join(tmpDir, 'trace-out');
  const extract = extractFailures(traceZipPath, outDir);

  // 1. Traces count
  assert.strictEqual(extract.traces.length, 1);
  const tr = extract.traces[0];

  // 2. Failed action check
  assert.strictEqual(tr.actions.failedActions.length, 1);
  const failedAction = tr.actions.failedActions[0];
  assert.strictEqual(failedAction.action, 'locator.click');
  assert.strictEqual(failedAction.selector, 'button[data-testid="enroll-button"]');
  assert.ok(failedAction.sourceLine.includes('tests/checkout.spec.ts:32:15'));
  assert.ok(failedAction.logTail.length >= 2);
  assert.ok(failedAction.logTail.some(l => l.includes('button disabled')));

  // 3. Network check
  assert.strictEqual(tr.network.httpFailures.length, 1);
  assert.strictEqual(tr.network.httpFailures[0].status, 502);

  assert.strictEqual(tr.network.graphqlErrors.length, 1);
  assert.ok(tr.network.graphqlErrors[0].graphqlErrors[0].includes('Payment gateway timeout'));

  // 4. Noise filter check (React hydration error #418 filtered out, uncaught error kept)
  assert.strictEqual(tr.actions.consoleErrors.length, 1);
  assert.ok(tr.actions.consoleErrors[0].text.includes('Cannot read properties of undefined'));

  // 5. Screenshots
  assert.strictEqual(extract.screenshots.length, 1);
  assert.ok(fs.existsSync(path.join(outDir, 'screenshots', extract.screenshots[0].file)));

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

