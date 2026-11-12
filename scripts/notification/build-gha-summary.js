/**
 * GitHub Actions Step Summary & PR Markdown Generator
 * Renders an investigation-grade breakdown directly in GitHub Actions UI.
 */

const fs = require('fs');

function buildGhaSummary(options) {
  const {
    testPath = '',
    environment = 'production',
    category = 'PRODUCTION',
    executionId = '',
    analysisFile = null,
    traceFile = null,
    errorFile = null,
    outputFile = null
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

  const classification = analysis.classification || 'unknown';
  const confidence = analysis.confidence || 'low';
  const casualSummary = analysis.casualSummary || 'No summary available.';
  const rootCause = analysis.rootCause || '';
  const trigger = analysis.trigger || '';
  const failingAssertion = analysis.failingAssertion || '';
  const suggestedFix = analysis.suggestedFix || '';
  const ruledOut = analysis.ruledOut || '';
  const affectedComponent = analysis.affectedComponent || 'Unknown';
  const llmStats = analysis.llmStats || {};
  const versionCheck = analysis.versionCheck || null;

  const classIcons = {
    real_bug: '🐛 **REAL BUG**',
    flaky_test: '🔄 **FLAKY TEST**',
    env_issue: '🌐 **ENVIRONMENT ISSUE**',
    test_maintenance: '🔧 **TEST MAINTENANCE**',
    data_issue: '📊 **DATA ISSUE**',
    unknown: '🔍 **UNKNOWN**'
  };

  let md = `## 🎭 Playwright Trace Analysis Verdict\n\n`;

  md += `| Test File | Classification | Confidence | Component | Category |\n`;
  md += `| :--- | :--- | :--- | :--- | :--- |\n`;
  md += `| \`${testPath}\` | ${classIcons[classification] || classification} | \`${confidence.toUpperCase()}\` | \`${affectedComponent}\` | \`${category}\` |\n\n`;

  md += `> 💡 **Summary**: *${casualSummary}*\n\n`;

  if (versionCheck && versionCheck.title) {
    const icon = versionCheck.status === 'fix_not_in_run' ? '🕐' : '⚠️';
    md += `> ${icon} **${versionCheck.title}**: ${versionCheck.message}\n\n`;
  }

  md += `### 🔍 Why It Failed\n\n`;
  if (trigger) md += `- **Trigger**: ${trigger}\n`;
  if (suggestedFix) md += `- **Suggested Fix**: ${suggestedFix}\n`;
  if (ruledOut) md += `- **Ruled Out**: ${ruledOut}\n`;

  if (failingAssertion) {
    md += `\n**Failing Assertion**:\n\`\`\`text\n${failingAssertion}\n\`\`\`\n`;
  }

  if (rootCause) {
    md += `\n### 🧠 Root Cause Details\n\n`;
    const lines = rootCause.split('\n').filter(Boolean);
    for (const l of lines) {
      md += `${l.startsWith('-') ? l : '- ' + l}\n`;
    }
  }

  // Network failures table
  const httpFailures = [];
  const graphqlErrors = [];
  if (trace.traces) {
    for (const t of trace.traces) {
      if (t.network?.httpFailures) httpFailures.push(...t.network.httpFailures);
      if (t.network?.graphqlErrors) graphqlErrors.push(...t.network.graphqlErrors);
    }
  }

  if (httpFailures.length > 0 || graphqlErrors.length > 0) {
    md += `\n### 🌐 Failed Network Requests\n\n`;
    md += `| Method | Status | Type | URL / Error |\n`;
    md += `| :--- | :--- | :--- | :--- |\n`;

    for (const ge of graphqlErrors.slice(0, 5)) {
      md += `| \`${ge.method}\` | \`${ge.status}\` | GraphQL | \`${ge.url}\`<br>↳ *${(ge.graphqlErrors || []).join('; ')}* |\n`;
    }
    for (const hf of httpFailures.slice(0, 8)) {
      md += `| \`${hf.method}\` | \`${hf.status}\` | HTTP | \`${hf.url}\` |\n`;
    }
  }

  if (analysis.relatedLinks && analysis.relatedLinks.length > 0) {
    md += `\n### 🔗 Related Links\n\n`;
    for (const l of analysis.relatedLinks) {
      md += `- [${l.title}](${l.url}) — *${l.relevance}*\n`;
    }
  }

  md += `\n---\n*Analyzed with AI model: \`${llmStats.model || 'auto'}\` in ${Math.round((llmStats.duration_ms || 0) / 1000)}s*\n`;

  if (outputFile) {
    fs.writeFileSync(outputFile, md, 'utf8');
  }

  return md;
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

  const summary = buildGhaSummary(options);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n\n', 'utf8');
    console.log('Appended summary to $GITHUB_STEP_SUMMARY');
  } else {
    console.log(summary);
  }
}

module.exports = {
  buildGhaSummary
};

