/**
 * Slack Block Kit Answer Card Generator
 * Follows exact specifications from BUILD-FROM-SCRATCH.md (Section 5.14).
 */

const fs = require('fs');

function buildAnswerBlocks(options) {
  const {
    testPath = '',
    analysisFile = null,
    requester = '',
    outputFile = null
  } = options;

  let analysis = {};
  if (analysisFile && fs.existsSync(analysisFile)) {
    try {
      analysis = JSON.parse(fs.readFileSync(analysisFile, 'utf8'));
    } catch (e) {}
  }

  const answer = analysis.answer || 'No answer generated.';
  const confidence = analysis.confidence || 'medium';
  const prefix = requester ? `<@${requester}>\n` : '';

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${prefix}*Answer regarding \`${testPath}\`*:\n${answer}\n\n_Confidence: \`${confidence}\`_`
      }
    }
  ];

  if (analysis.relatedLinks && analysis.relatedLinks.length > 0) {
    const actionElements = analysis.relatedLinks.slice(0, 4).map(l => ({
      type: 'button',
      text: { type: 'plain_text', text: l.title.slice(0, 24) },
      url: l.url
    }));

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
  buildAnswerBlocks
};

