const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runPipeline } = require('../runner/run-pipeline');
const { createSampleTraceZip } = require('./fixtures/generate-fixture');

test('E2E Pipeline execution generates all artifacts and deduplicates correctly', async () => {
  const tmpDir = path.join(__dirname, 'tmp_e2e_run');
  fs.mkdirSync(tmpDir, { recursive: true });

  const traceZipPath = path.join(tmpDir, 'trace-fixture.zip');
  createSampleTraceZip(traceZipPath);

  const testSpec = 'checkout/enrollment.spec.ts';
  const workDir = path.join(tmpDir, 'work');
  const dbFile = path.join(tmpDir, 'db.json');

  // 1. First run: full analysis
  const res1 = await runPipeline({
    trace: traceZipPath,
    test: testSpec,
    provider: 'mock',
    workDir,
    dbFile,
    dedupHours: 24,
    buildNumber: '101'
  });

  assert.strictEqual(res1.status, 'completed');
  assert.ok(res1.verdict);
  assert.ok(fs.existsSync(res1.artifacts.html), 'report.html must exist');
  assert.ok(fs.existsSync(res1.artifacts.analysisJson), 'analysis-result.json must exist');
  assert.ok(fs.existsSync(res1.artifacts.ghaSummary), 'summary.md must exist');
  assert.ok(fs.existsSync(res1.artifacts.slackBlocks), 'main-blocks.json must exist');

  // Verify HTML contents
  const htmlContent = fs.readFileSync(res1.artifacts.html, 'utf8');
  assert.ok(htmlContent.includes('Trace Analysis: checkout/enrollment.spec.ts'));
  assert.ok(htmlContent.includes('Why It Failed'));

  // 2. Second run with same error & dedupHours: 24 -> Should trigger Reuse Gate!
  const res2 = await runPipeline({
    trace: traceZipPath,
    test: testSpec,
    provider: 'mock',
    workDir,
    dbFile,
    dedupHours: 24,
    buildNumber: '102'
  });

  assert.strictEqual(res2.status, 'reused', 'Second run should hit deduplication reuse gate');
  assert.ok(res2.prior);
  assert.strictEqual(res2.prior.buildNumber, 101);

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
