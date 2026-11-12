/**
 * Slack Block Kit Reuse Card Generator
 * Follows exact specifications from BUILD-FROM-SCRATCH.md (Section 5.14).
 */

const fs = require('fs');

function buildReuseBlocks(options) {
  const {
    testPath = '',
    priorFile = null,
    disableUrl = '',
    outputFile = null
  } = options;

  let prior = {};
  if (priorFile && fs.existsSync(priorFile)) {
    try {
      prior = JSON.parse(fs.readFileSync(priorFile, 'utf8'));
    } catch (e) {}
  }

  const summary = prior.casualSummary || 'Same failure signature as previous analysis run.';
  const reportUrl = prior.htmlReportUrl || '';

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🔁 *Same as previous analysis* — \`${testPath}\`\n>${summary}`
      }
    }
  ];

  const actionElements = [];
  if (reportUrl) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: '📊 Full Report' },
      url: reportUrl
    });
  }
  if (disableUrl) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: '🔕 Disable test' },
      url: disableUrl,
      style: 'primary'
    });
  }

  if (actionElements.length > 0) {
    blocks.push({
      type: 'actions',
      elements: actionElements
    });
  }

  const payload = { blocks };
  if (outputFile) {
    fs.writeFileSync(outputFile, JSON.stringify(payload, null, 2), 'utf8');
  }

  return payload;
}

module.exports = {
  buildReuseBlocks
};

