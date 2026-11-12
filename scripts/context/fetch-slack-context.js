/**
 * Fetch Slack Context & Keyword Classification
 * Follows exact specifications from BUILD-FROM-SCRATCH.md (Section 5.5).
 */

const fs = require('fs');

const OUTAGE_PATTERNS = [
  /\boutage\b/i,
  /\bdowntime\b/i,
  /\bdown\b/i,
  /\binfra issue\b/i,
  /\benv issue\b/i
];

const KNOWN_PATTERNS = [
  /\bknown issue\b/i,
  /\balready tracked\b/i,
  /\b[A-Z]{2,10}-\d+\b/ // Match case-sensitive Jira ticket like PROD-1234
];

const INVESTIGATING_PATTERNS = [
  /\blooking into\b/i,
  /\bon it\b/i,
  /\binvestigating\b/i
];

const NEGATION_PATTERNS = [
  /\bnot an outage\b/i,
  /\bnot down\b/i,
  /\bnot an infra\b/i
];

function classifyReply(text) {
  if (!text) return 'none';
  if (NEGATION_PATTERNS.some(p => p.test(text))) return 'none';

  if (OUTAGE_PATTERNS.some(p => p.test(text))) return 'outage';
  if (KNOWN_PATTERNS.some(p => p.test(text))) return 'known_issue';
  if (INVESTIGATING_PATTERNS.some(p => p.test(text))) return 'investigating';

  return 'none';
}

async function fetchSlackContext(options) {
  const {
    slackThreadsFile = null,
    outputFile = null,
    slackToken = process.env.SLACK_BOT_TOKEN
  } = options;

  const result = {
    searched: false,
    threadsSearched: 0,
    humanReplyCount: 0,
    linkedThreadsFetched: 0,
    classification: 'none',
    gateSignal: false,
    threads: [],
    error: null
  };

  let inputThreads = [];
  if (slackThreadsFile && fs.existsSync(slackThreadsFile)) {
    try {
      inputThreads = JSON.parse(fs.readFileSync(slackThreadsFile, 'utf8'));
    } catch (e) {}
  }

  result.threadsSearched = inputThreads.length;

  for (const item of inputThreads) {
    const threadData = {
      channelId: item.channelId,
      threadTs: item.threadTs,
      classification: 'none',
      replies: []
    };

    if (item.replies && Array.isArray(item.replies)) {
      for (const r of item.replies) {
        const cls = classifyReply(r.text);
        if (cls === 'outage' || cls === 'known_issue') {
          threadData.classification = cls;
          result.gateSignal = true;
          result.classification = cls;
        }
        threadData.replies.push({
          user: r.user || 'engineer',
          text: r.text || '',
          ts: r.ts || '',
          classification: cls
        });
        result.humanReplyCount++;
      }
    }

    result.threads.push(threadData);
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
    if (args[i] === '--threads' && args[i + 1]) options.slackThreadsFile = args[++i];
    if (args[i] === '--output' && args[i + 1]) options.outputFile = args[++i];
  }

  fetchSlackContext(options)
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}

module.exports = {
  fetchSlackContext,
  classifyReply
};

