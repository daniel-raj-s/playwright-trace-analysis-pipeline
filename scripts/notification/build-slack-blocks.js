/**
 * Slack Block Kit Card Generator
 * Follows exact specifications from BUILD-FROM-SCRATCH.md (Section 5.12).
 */

const fs = require('fs');

function tldr(text, maxLen = 300) {
  if (!text) return '';
  let cleaned = String(text)
    .replace(/<https?:\/\/[^|>]+(?:\|([^>]+))?>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/`+/g, '')
    .trim();

  if (cleaned.length <= maxLen) return cleaned;
  // Break at clause or word
  const sliced = cleaned.slice(0, maxLen - 3);
  const lastSpace = sliced.lastIndexOf(' ');
  return (lastSpace > 0 ? sliced.slice(0, lastSpace) : sliced) + '…';
}

function buildSlackBlocks(options) {
  const {
    testPath = '',
    analysisFile = null,
    traceFile = null,
    htmlUrl = '',
    disableUrl = '',
    fixUrl = '',
    askUrl = '',
    jiraFileUrl = '',
    sparkline = '🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩',
    failureCount = 0,
    screenshotsBaseUrl = '',
    loopTotal = 0,
    loopFailed = 0,
    traceAnalysisBuildNumber = 1,
    outputFile = null
  } = options;

  let analysis = {};
  if (analysisFile && fs.existsSync(analysisFile)) {
    try {
      analysis = JSON.parse(fs.readFileSync(analysisFile, 'utf8'));
    } catch (e) {}
  }

  const classification = analysis.classification || 'unknown';
  const confidence = analysis.confidence || 'low';
  const casualSummary = analysis.casualSummary || '';
  const trigger = analysis.trigger || '';
  const failingAssertion = analysis.failingAssertion || '';
  const suggestedFix = analysis.suggestedFix || '';
  const affectedComponent = analysis.affectedComponent || 'Unknown';
  const ruledOut = analysis.ruledOut || '';
  const existingFix = analysis.existingFix || null;
  const versionCheck = analysis.versionCheck || null;
  const llmStats = analysis.llmStats || {};

  const classBadges = {
    real_bug: '🐛 *REAL BUG*',
    flaky_test: '🔄 *FLAKY TEST*',
    env_issue: '🌐 *ENV ISSUE*',
    test_maintenance: '🔧 *TEST MAINTENANCE*',
    data_issue: '📊 *DATA ISSUE*',
    unknown: '🔍 *UNKNOWN*'
  };

  let dots = '⚪⚪⚪';
  if (loopTotal > 0) {
    if (loopFailed === loopTotal) dots = '🔴🔴🔴';
    else if (loopFailed === 0) dots = '🟢🟢🟢';
    else dots = '🟡🟡🟡';
  }

  const blocks = [];

  // 1. Header Block
  const headerSection = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `${classBadges[classification] || classification} · \`${confidence}\` · ${dots} \`${loopFailed}/${loopTotal}\`\n*${testPath}*`
    }
  };
  if (htmlUrl) {
    headerSection.accessory = {
      type: 'button',
      text: { type: 'plain_text', text: 'View Report →' },
      url: htmlUrl,
      style: 'primary'
    };
  }
  blocks.push(headerSection);

  // 2. Summary Quote
  if (casualSummary) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `> _${tldr(casualSummary, 280)}_`
      }
    });
  }

  // 3. Version Check Callout
  if (versionCheck && (versionCheck.status === 'fix_not_in_run' || versionCheck.status === 'fix_in_run')) {
    const icon = versionCheck.status === 'fix_not_in_run' ? '🕐' : '⚠️';
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${icon} *${versionCheck.title}* — ${versionCheck.message}`
      }
    });
  }

  // 4. Existing Fix Notice
  if (existingFix) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `✅ *Fix already exists*: ${tldr(existingFix, 220)}`
      }
    });
  }

  // 5. Bullet List
  let bulletsText = '';
  if (trigger) bulletsText += `• *Why*: ${tldr(trigger, 160)}\n`;
  if (failingAssertion) bulletsText += `• *Failed at*: \`${tldr(failingAssertion, 140)}\`\n`;
  if (suggestedFix && !existingFix) bulletsText += `• *Suggested fix*: ${tldr(suggestedFix, 160)}\n`;
  if (affectedComponent) bulletsText += `• *Affected*: \`${affectedComponent}\`\n`;
  if (ruledOut) bulletsText += `• *Ruled out*: ${tldr(ruledOut, 160)}\n`;
  bulletsText += `• *History*: ${failureCount} failure(s) in 30d · ${sparkline}`;

  // Spec §5.12 / Pitfall #32: section text hard limit 3000 chars — over this limit, Slack rejects the WHOLE message
  if (bulletsText.length > 3000) {
    bulletsText = bulletsText.slice(0, 2990) + '…';
  }

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: bulletsText
    }
  });

  // 6. Screenshot Image (if provided and valid)
  const chosenScreenshot = analysis.chosenScreenshotFile;
  if (chosenScreenshot && screenshotsBaseUrl) {
    const imageUrl = `${screenshotsBaseUrl.replace(/\/+$/, '')}/${chosenScreenshot}`;
    blocks.push({
      type: 'image',
      image_url: imageUrl,
      alt_text: 'Failure Screenshot',
      title: {
        type: 'plain_text',
        text: 'Failure Screenshot'
      }
    });
  }

  // 7. Actions Button Bar
  const actionElements = [];
  if (fixUrl && !existingFix) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: '🔧 Request fix' },
      url: fixUrl
    });
  }
  if (classification === 'real_bug' && jiraFileUrl) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: '🐞 File Jira bug' },
      url: jiraFileUrl
    });
  }
  if (disableUrl) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: '🔕 Disable test' },
      url: disableUrl
    });
  }
  if (askUrl) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: '❓ Ask' },
      url: askUrl
    });
  }

  // Related Link buttons (up to 4 total)
  if (analysis.relatedLinks) {
    for (const l of analysis.relatedLinks) {
      if (actionElements.length >= 4) break;
      actionElements.push({
        type: 'button',
        text: { type: 'plain_text', text: l.title.slice(0, 24) },
        url: l.url
      });
    }
  }

  if (actionElements.length > 0) {
    blocks.push({
      type: 'actions',
      elements: actionElements.slice(0, 5)
    });
  }

  // 8. Footer Context
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `⚡ trace-analysis #${traceAnalysisBuildNumber} · ${llmStats.num_turns || 1} turns · ${llmStats.model || 'auto'}`
      }
    ]
  });

  const payload = { blocks };
  if (outputFile) {
    fs.writeFileSync(outputFile, JSON.stringify(payload, null, 2), 'utf8');
  }

  return payload;
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

  const res = buildSlackBlocks(options);
  console.log(`Slack blocks created (${res.blocks.length} blocks).`);
}

module.exports = {
  buildSlackBlocks,
  tldr
};

