/**
 * Post Analysis Summary to GitHub PR / Issue Comment
 */

const fs = require('fs');

async function postGitHubComment(options) {
  const {
    summaryFile = null,
    prNumber = process.env.PR_NUMBER,
    repo = process.env.GITHUB_REPOSITORY,
    token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  } = options;

  if (!token) {
    console.log('No GITHUB_TOKEN provided; skipping PR comment.');
    return { ok: false, error: 'no_token' };
  }

  if (!repo || !prNumber) {
    console.log('Not in a PR context (GITHUB_REPOSITORY or PR_NUMBER missing); skipping PR comment.');
    return { ok: false, error: 'not_in_pr' };
  }

  let body = '';
  if (summaryFile && fs.existsSync(summaryFile)) {
    body = fs.readFileSync(summaryFile, 'utf8');
  } else if (options.body) {
    body = options.body;
  }

  if (!body) {
    return { ok: false, error: 'empty_body' };
  }

  try {
    const url = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'trace-analysis-pipeline'
      },
      body: JSON.stringify({ body })
    });

    const data = await res.json();
    return {
      ok: res.ok,
      commentId: data.id,
      url: data.html_url
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
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

  postGitHubComment(options)
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch(e => { console.error(e); process.exit(1); });
}

module.exports = {
  postGitHubComment
};

