/**
 * Slack Post Chokepoint
 * Follows exact specifications from BUILD-FROM-SCRATCH.md (Section 5.13 & 8).
 * Neutralizes mass pings (<!channel> -> &lt;!channel>) everywhere.
 */

const fs = require('fs');

function sanitizeText(obj) {
  if (typeof obj === 'string') {
    return obj.replace(/<!/g, '&lt;!');
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeText);
  }
  if (obj && typeof obj === 'object') {
    const copy = {};
    for (const [k, v] of Object.entries(obj)) {
      copy[k] = sanitizeText(v);
    }
    return copy;
  }
  return obj;
}

async function postSlack(options) {
  const {
    token = process.env.SLACK_BOT_TOKEN,
    channel = process.env.SLACK_CHANNEL || process.env.SLACK_DEFAULT_CHANNEL || '',
    mainBlocksFile = null,
    alertThreadTs = null,
    alertChannelId = null,
    textFallback = 'Playwright Trace Analysis Report',
    outputFile = null
  } = options;

  let blocks = [];
  if (mainBlocksFile && fs.existsSync(mainBlocksFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(mainBlocksFile, 'utf8'));
      blocks = data.blocks || data;
    } catch (e) {}
  }

  const targetChannel = alertChannelId || channel;
  const sanitizedBlocks = sanitizeText(blocks);

  const payload = {
    channel: targetChannel,
    text: sanitizeText(textFallback),
    blocks: sanitizedBlocks,
    unfurl_links: false,
    unfurl_media: false
  };

  if (alertThreadTs) {
    payload.thread_ts = alertThreadTs;
  }

  const result = {
    ok: false,
    channel: targetChannel,
    ts: null
  };

  if (!token) {
    console.warn('SLACK_BOT_TOKEN not provided; skipping Slack post.');
    result.error = 'no_token';
  } else {
    try {
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      result.ok = data.ok;
      result.ts = data.ts;
      if (!data.ok) {
        result.error = data.error;
      }
    } catch (e) {
      result.error = e.message;
    }
  }

  if (outputFile) {
    fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf8');
  }

  return result;
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

  postSlack(options)
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}

module.exports = {
  postSlack,
  sanitizeText
};

