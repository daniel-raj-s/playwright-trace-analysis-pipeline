const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseLlmResponse, extractJsonSubstring } = require('../llm/parse-llm-response');

test('extractJsonSubstring extracts JSON inside markdown fences', () => {
  const markdown = 'Here is the analysis:\n```json\n{\n  "classification": "real_bug",\n  "confidence": "high"\n}\n```\nHope this helps!';
  const extracted = extractJsonSubstring(markdown);
  assert.ok(extracted);
  const parsed = JSON.parse(extracted);
  assert.strictEqual(parsed.classification, 'real_bug');
});

test('parseLlmResponse normalizes analysis fields and clamps lengths', () => {
  const tmpFile = path.join(__dirname, 'tmp_llm_raw.json');
  const dummyVerdict = {
    classification: 'real_bug',
    confidence: 'high',
    casualSummary: 'Button was unclickable due to state mutation lag.',
    rootCause: ['- Button stayed disabled', '- State did not update'],
    trigger: 'Disabled button on checkout form',
    failingAssertion: 'expect(locator).toBeEnabled()',
    suggestedFix: 'Fix component state hook'
  };

  fs.writeFileSync(tmpFile, JSON.stringify({ type: 'result', result: JSON.stringify(dummyVerdict) }), 'utf8');

  const normalized = parseLlmResponse({
    inputFile: tmpFile,
    mode: 'analysis'
  });

  assert.strictEqual(normalized.classification, 'real_bug');
  assert.strictEqual(normalized.confidence, 'high');
  assert.strictEqual(normalized.casualSummary, 'Button was unclickable due to state mutation lag.');
  assert.ok(normalized.rootCause.includes('- Button stayed disabled'));

  fs.rmSync(tmpFile, { force: true });
});

test('parseLlmResponse salvages partial JSON from truncated stream', () => {
  const tmpFile = path.join(__dirname, 'tmp_llm_trunc.json');
  const truncatedStream = '{"classification": "env_issue", "confidence": "high", "casualSummary": "Gateway timeout during checkout", "root';
  fs.writeFileSync(tmpFile, truncatedStream, 'utf8');

  const salvaged = parseLlmResponse({
    inputFile: tmpFile,
    mode: 'analysis'
  });

  assert.strictEqual(salvaged.classification, 'env_issue');
  assert.strictEqual(salvaged.confidence, 'high');
  assert.ok(salvaged.casualSummary.includes('Gateway timeout'));
  assert.strictEqual(salvaged.llmStats.salvagedFromPartialOutput, true);

  fs.rmSync(tmpFile, { force: true });
});

