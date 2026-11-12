/**
 * Synthetic Playwright Trace Fixture Generator
 * Creates realistic Playwright trace ZIP archives for testing and verification.
 */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

function createSampleTraceZip(outputPath) {
  const zip = new AdmZip();

  const wallTime = Date.now();
  const monotonicTime = 1000.0;

  // 1. trace.trace events (JSONL)
  const traceEvents = [
    { type: 'context-options', wallTime, monotonicTime, browserName: 'chromium', viewport: { width: 1280, height: 720 } },
    { type: 'navigation', url: 'https://app.example.com/checkout', time: 1050.0 },
    { type: 'before', callId: 'call@1', method: 'page.goto', startTime: 1010.0, params: { url: 'https://app.example.com/checkout' } },
    { type: 'after', callId: 'call@1', endTime: 1100.0 },
    { type: 'step', title: 'Open checkout dialog', duration: 150, error: null },
    { type: 'before', callId: 'call@2', method: 'locator.click', startTime: 1200.0, params: { selector: 'button[data-testid="enroll-button"]' } },
    { type: 'log', callId: 'call@2', message: 'waiting for locator("button[data-testid=\\"enroll-button\\"]") to be visible' },
    { type: 'log', callId: 'call@2', message: 'resolved to <button disabled data-testid="enroll-button">Enroll</button>' },
    { type: 'log', callId: 'call@2', message: 'element is not enabled - waiting...' },
    {
      type: 'after',
      callId: 'call@2',
      endTime: 11200.0,
      error: {
        message: 'Timeout 10000ms exceeded waiting for locator("button[data-testid=\\"enroll-button\\"]").toBeEnabled()',
        stack: 'Error: Timeout 10000ms exceeded\n    at CheckoutPage.enroll (checkout.page.ts:45:10)\n    at Object.<anonymous> (tests/checkout.spec.ts:32:15)'
      }
    },
    // Console error with React hydration noise (should be filtered)
    { type: 'console', messageType: 'error', text: 'Warning: Text content did not match. Server: "Enroll" Client: "Join" #418', time: 1100.0 },
    // Real console error (should be kept)
    { type: 'console', messageType: 'error', text: 'Uncaught TypeError: Cannot read properties of undefined (reading "checkoutSession")', time: 1250.0 }
  ];

  const traceContent = traceEvents.map(e => JSON.stringify(e)).join('\n');
  zip.addFile('0-trace.trace', Buffer.from(traceContent, 'utf8'));

  // 2. trace.network events (JSONL)
  const networkEvents = [
    {
      type: 'resource-snapshot',
      request: { method: 'GET', url: 'https://app.example.com/api/userPreferences.v1' }, // noise url
      response: { status: 200 }
    },
    {
      type: 'resource-snapshot',
      request: { method: 'POST', url: 'https://app.example.com/api/graphql' },
      response: {
        status: 200,
        content: {
          text: JSON.stringify({
            data: null,
            errors: [{ message: 'Payment gateway timeout during enrollment verification' }]
          })
        }
      }
    },
    {
      type: 'resource-snapshot',
      request: { method: 'GET', url: 'https://app.example.com/api/checkout/session' },
      response: {
        status: 502,
        headers: { 'x-request-id': 'req-98765-err' },
        content: { text: '<html><body>502 Bad Gateway</body></html>' }
      }
    }
  ];

  const networkContent = networkEvents.map(e => JSON.stringify(e)).join('\n');
  zip.addFile('0-trace.network', Buffer.from(networkContent, 'utf8'));

  // 3. resources/ with valid PNG-magic dummy screenshot (> 1KB)
  // PNG magic bytes: 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
  const dummyImageBytes = Buffer.alloc(2048, 0x00);
  dummyImageBytes[0] = 0x89; dummyImageBytes[1] = 0x50;
  dummyImageBytes[2] = 0x4E; dummyImageBytes[3] = 0x47;
  zip.addFile('resources/page@a1b2c3d4-123456.png', dummyImageBytes);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  zip.writeZip(outputPath);
  return outputPath;
}

module.exports = {
  createSampleTraceZip
};
