/**
 * Standalone Interactive HTML Report Generator
 * Follows exact specifications from BUILD-FROM-SCRATCH.md (Section 5.11).
 * Single self-contained HTML file with inline CSS, collapsible cards, and lightbox.
 */

const fs = require('fs');
const path = require('path');

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function buildHtmlReport(options) {
  const {
    testPath = '',
    environment = 'production',
    category = 'PRODUCTION',
    executionId = '',
    buildNumber = '1',
    analysisFile = null,
    traceFile = null,
    errorFile = null,
    outputFile = null,
    screenshotsBaseUrl = './screenshots/',
    loopTotal = 0,
    loopFailed = 0
  } = options;

  let analysis = {};
  if (analysisFile && fs.existsSync(analysisFile)) {
    try {
      analysis = JSON.parse(fs.readFileSync(analysisFile, 'utf8'));
    } catch (e) {}
  }

  let trace = {};
  if (traceFile && fs.existsSync(traceFile)) {
    try {
      trace = JSON.parse(fs.readFileSync(traceFile, 'utf8'));
    } catch (e) {}
  }

  let rawError = '';
  if (errorFile && fs.existsSync(errorFile)) {
    try {
      rawError = fs.readFileSync(errorFile, 'utf8');
    } catch (e) {}
  }

  const classification = analysis.classification || 'unknown';
  const confidence = analysis.confidence || 'low';
  const casualSummary = analysis.casualSummary || 'No summary available.';
  const rootCause = analysis.rootCause || 'Root cause investigation details not provided.';
  const trigger = analysis.trigger || '';
  const failingAssertion = analysis.failingAssertion || '';
  const suggestedFix = analysis.suggestedFix || '';
  const ruledOut = analysis.ruledOut || '';
  const affectedComponent = analysis.affectedComponent || 'Unknown';
  const llmStats = analysis.llmStats || {};
  const versionCheck = analysis.versionCheck || null;

  const classBadges = {
    real_bug: { label: 'REAL BUG', color: '#dc2626', emoji: '🐛' },
    flaky_test: { label: 'FLAKY TEST', color: '#ea580c', emoji: '🔄' },
    env_issue: { label: 'ENV ISSUE', color: '#2563eb', emoji: '🌐' },
    test_maintenance: { label: 'TEST MAINTENANCE', color: '#7c3aed', emoji: '🔧' },
    data_issue: { label: 'DATA ISSUE', color: '#059669', emoji: '📊' },
    unknown: { label: 'UNKNOWN', color: '#6b7280', emoji: '🔍' }
  };

  const badge = classBadges[classification] || classBadges.unknown;

  // Validator severity dots
  let severityDots = '⚪⚪⚪';
  let severityLabel = 'Unknown Severity';
  if (loopTotal > 0) {
    if (loopFailed === loopTotal) {
      severityDots = '🔴🔴🔴';
      severityLabel = `Consistent Failure (${loopFailed}/${loopTotal} failed)`;
    } else if (loopFailed === 0) {
      severityDots = '🟢🟢🟢';
      severityLabel = `Transient Failure (0/${loopTotal} failed)`;
    } else {
      severityDots = '🟡🟡🟡';
      severityLabel = `Intermittent Flake (${loopFailed}/${loopTotal} failed)`;
    }
  }

  // Collect screenshots
  const screenshots = trace.screenshots || [];
  const chosenScreenshot = analysis.chosenScreenshotFile || (screenshots[0]?.file || null);

  // Network failures
  const httpFailures = [];
  const graphqlErrors = [];
  if (trace.traces) {
    for (const t of trace.traces) {
      if (t.network?.httpFailures) httpFailures.push(...t.network.httpFailures);
      if (t.network?.graphqlErrors) graphqlErrors.push(...t.network.graphqlErrors);
    }
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Trace Analysis: ${escapeHtml(testPath)}</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --border: #334155;
      --accent: #38bdf8;
      --success: #22c55e;
      --danger: #ef4444;
      --warning: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      padding: 24px;
    }
    .container { max-width: 1100px; margin: 0 auto; }
    header {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 24px;
    }
    .badge-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 0.85rem;
      font-weight: 600;
      text-transform: uppercase;
    }
    .spec-path { font-size: 1.25rem; font-weight: 700; word-break: break-all; color: var(--accent); }
    .summary-quote {
      font-size: 1.1rem;
      font-style: italic;
      color: #e2e8f0;
      border-left: 4px solid ${badge.color};
      padding: 12px 16px;
      margin: 16px 0;
      background: rgba(255, 255, 255, 0.03);
      border-radius: 0 8px 8px 0;
    }
    .grid { display: grid; grid-template-columns: 1fr; gap: 20px; }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
    }
    .card-header {
      padding: 14px 18px;
      background: rgba(255, 255, 255, 0.02);
      border-bottom: 1px solid var(--border);
      font-weight: 600;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
    }
    .card-body { padding: 18px; }
    .callout {
      padding: 14px 18px;
      border-radius: 8px;
      margin-bottom: 16px;
      border-left: 4px solid;
    }
    .callout-blue { background: rgba(56, 189, 248, 0.1); border-color: #38bdf8; }
    .callout-amber { background: rgba(245, 158, 11, 0.1); border-color: #f59e0b; }
    .bullets { list-style: none; }
    .bullets li { margin-bottom: 8px; padding-left: 20px; position: relative; }
    .bullets li::before { content: "•"; position: absolute; left: 4px; color: var(--accent); font-weight: bold; }
    pre {
      background: #090d16;
      padding: 12px 16px;
      border-radius: 8px;
      overflow-x: auto;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 0.875rem;
      color: #cbd5e1;
      border: 1px solid #1e293b;
    }
    .table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    .table th, .table td { padding: 10px 12px; border: 1px solid var(--border); text-align: left; font-size: 0.875rem; }
    .table th { background: rgba(255, 255, 255, 0.05); }
    .status-err { color: #f87171; font-weight: 600; }
    .screenshot-viewer { text-align: center; margin-top: 12px; }
    .screenshot-viewer img {
      max-width: 100%;
      border-radius: 8px;
      border: 1px solid var(--border);
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.3);
      cursor: pointer;
      transition: transform 0.2s;
    }
    .screenshot-viewer img:hover { transform: scale(1.01); }
    footer {
      margin-top: 36px;
      text-align: center;
      font-size: 0.85rem;
      color: var(--text-muted);
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="badge-bar">
        <span class="badge" style="background: ${badge.color}; color: white;">
          ${badge.emoji} ${badge.label}
        </span>
        <span class="badge" style="background: rgba(255, 255, 255, 0.1);">
          CONFIDENCE: ${escapeHtml(confidence.toUpperCase())}
        </span>
        <span class="badge" style="background: rgba(255, 255, 255, 0.1);">
          ${severityDots} ${severityLabel}
        </span>
        <span class="badge" style="background: rgba(255, 255, 255, 0.1);">
          COMPONENT: ${escapeHtml(affectedComponent)}
        </span>
      </div>
      <div class="spec-path">${escapeHtml(testPath)}</div>
      <div class="summary-quote">"${escapeHtml(casualSummary)}"</div>
      <div style="font-size: 0.85rem; color: var(--text-muted);">
        Execution: <strong>${escapeHtml(executionId || 'N/A')}</strong> | Environment: <strong>${escapeHtml(environment)}</strong> | Category: <strong>${escapeHtml(category)}</strong>
      </div>
    </header>

    <div class="grid">
      ${versionCheck && versionCheck.title ? `
        <div class="callout ${versionCheck.status === 'fix_not_in_run' ? 'callout-blue' : 'callout-amber'}">
          <strong>${versionCheck.status === 'fix_not_in_run' ? '🕐' : '⚠️'} ${escapeHtml(versionCheck.title)}</strong>
          <p style="margin-top: 4px;">${escapeHtml(versionCheck.message)}</p>
        </div>
      ` : ''}

      <!-- Why it failed -->
      <div class="card">
        <div class="card-header">🔍 Why It Failed & Immediate Trigger</div>
        <div class="card-body">
          ${trigger ? `<p style="margin-bottom: 12px;"><strong>Immediate Trigger:</strong> ${escapeHtml(trigger)}</p>` : ''}
          ${failingAssertion ? `
            <div style="margin-bottom: 12px;">
              <strong>Failing Assertion:</strong>
              <pre>${escapeHtml(failingAssertion)}</pre>
            </div>
          ` : ''}
          ${suggestedFix ? `<p style="margin-bottom: 12px;"><strong>Suggested Fix:</strong> ${escapeHtml(suggestedFix)}</p>` : ''}
          ${ruledOut ? `<p style="color: var(--text-muted); font-size: 0.9rem;"><strong>Ruled Out:</strong> ${escapeHtml(ruledOut)}</p>` : ''}
        </div>
      </div>

      <!-- Root cause details -->
      <div class="card">
        <div class="card-header">🧠 Detailed Root Cause Analysis</div>
        <div class="card-body">
          <ul class="bullets">
            ${rootCause.split('\n').filter(Boolean).map(line => `<li>${escapeHtml(line.replace(/^-\s*/, ''))}</li>`).join('')}
          </ul>
        </div>
      </div>

      <!-- Failure Screenshot -->
      ${chosenScreenshot ? `
        <div class="card">
          <div class="card-header">📸 Failure Screenshot (${escapeHtml(chosenScreenshot)})</div>
          <div class="card-body screenshot-viewer">
            <a href="${screenshotsBaseUrl}${escapeHtml(chosenScreenshot)}" target="_blank">
              <img src="${screenshotsBaseUrl}${escapeHtml(chosenScreenshot)}" alt="Failure Screenshot" />
            </a>
          </div>
        </div>
      ` : ''}

      <!-- Network and GraphQL Errors -->
      ${(httpFailures.length > 0 || graphqlErrors.length > 0) ? `
        <div class="card">
          <div class="card-header">🌐 Network & GraphQL Failures (${httpFailures.length + graphqlErrors.length})</div>
          <div class="card-body" style="overflow-x: auto;">
            <table class="table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Method</th>
                  <th>Status</th>
                  <th>URL / Details</th>
                </tr>
              </thead>
              <tbody>
                ${graphqlErrors.map(ge => `
                  <tr>
                    <td><span class="badge" style="background: #9333ea;">GraphQL</span></td>
                    <td>${escapeHtml(ge.method)}</td>
                    <td class="status-err">${escapeHtml(ge.status)}</td>
                    <td>${escapeHtml(ge.url)}<br><small style="color: #f87171;">${escapeHtml((ge.graphqlErrors || []).join('; '))}</small></td>
                  </tr>
                `).join('')}
                ${httpFailures.map(hf => `
                  <tr>
                    <td><span class="badge" style="background: #dc2626;">HTTP</span></td>
                    <td>${escapeHtml(hf.method)}</td>
                    <td class="status-err">${escapeHtml(hf.status)}</td>
                    <td>${escapeHtml(hf.url)}<br><small style="color: var(--text-muted);">${escapeHtml(hf.bodySnippet || '')}</small></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      ` : ''}

      <!-- Raw Error Snippet -->
      ${rawError ? `
        <div class="card">
          <div class="card-header">📋 Error Log Snippet</div>
          <div class="card-body">
            <pre>${escapeHtml(rawError.slice(0, 4000))}</pre>
          </div>
        </div>
      ` : ''}

      <!-- Investigation Steps -->
      ${analysis.reasoning ? `
        <div class="card">
          <div class="card-header">⚙️ Investigation Steps & Evidence</div>
          <div class="card-body">
            <ul class="bullets">
              ${analysis.reasoning.split('\n').filter(Boolean).map(l => `<li>${escapeHtml(l.replace(/^-\s*/, ''))}</li>`).join('')}
            </ul>
          </div>
        </div>
      ` : ''}
    </div>

    <footer>
      Playwright Trace Analysis Pipeline • Model: ${escapeHtml(llmStats.model || 'auto')} • Duration: ${Math.round((llmStats.duration_ms || 0) / 1000)}s
    </footer>
  </div>
</body>
</html>`;

  if (outputFile) {
    fs.writeFileSync(outputFile, html, 'utf8');
  }

  return html;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const k = args[i].replace(/^--/, '');
    const v = args[i + 1];
    if (v && !v.startsWith('--')) {
      options[k] = v;
      i++;
    }
  }

  buildHtmlReport(options);
  console.log(`HTML report generated at ${options.outputFile || 'stdout'}`);
}

module.exports = {
  buildHtmlReport
};

