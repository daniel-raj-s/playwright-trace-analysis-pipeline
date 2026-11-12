/**
 * File Jira Bug from Verdict
 * Follows exact specifications from BUILD-FROM-SCRATCH.md (Section 5.16).
 */

const fs = require('fs');

async function fileJiraBug(options) {
  const {
    analysisFile = null,
    testPath = '',
    projectKey = 'QA',
    issueType = 'Bug',
    dryRun = false,
    outputFile = null
  } = options;

  let analysis = {};
  if (analysisFile && fs.existsSync(analysisFile)) {
    try {
      analysis = JSON.parse(fs.readFileSync(analysisFile, 'utf8'));
    } catch (e) {}
  }

  const summary = `[E2E Bug]: ${testPath} - ${analysis.casualSummary || 'Test Failure'}`.slice(0, 250);
  const result = {
    filed: false,
    dryRun: Boolean(dryRun),
    deduped: false,
    key: null,
    url: null,
    summary,
    error: null
  };

  const email = process.env.QE_JIRA_EMAIL || process.env.JIRA_EMAIL;
  const token = process.env.QE_JIRA_KEY || process.env.JIRA_API_TOKEN;
  const host = process.env.JIRA_HOST || 'your-company.atlassian.net';

  if (!email || !token) {
    result.error = 'no_credentials';
    if (outputFile) fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf8');
    return result;
  }

  if (dryRun) {
    result.key = 'QA-DRYRUN';
    result.url = `https://${host}/browse/QA-DRYRUN`;
    if (outputFile) fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf8');
    return result;
  }

  try {
    const auth = Buffer.from(`${email}:${token}`).toString('base64');
    const descText = `*Test Path*: ${testPath}\n*Root Cause*:\n${analysis.rootCause || 'N/A'}\n\n*Suggested Fix*:\n${analysis.suggestedFix || 'N/A'}`;

    const body = {
      fields: {
        project: { key: projectKey },
        summary,
        description: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: descText }]
            }
          ]
        },
        issuetype: { name: issueType }
      }
    };

    const res = await fetch(`https://${host}/rest/api/3/issue`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(body)
    });

    const data = await res.json();
    if (res.ok) {
      result.filed = true;
      result.key = data.key;
      result.url = `https://${host}/browse/${data.key}`;
    } else {
      result.error = `HTTP ${res.status}: ${JSON.stringify(data.errors || data)}`;
    }
  } catch (e) {
    result.error = e.message;
  }

  if (outputFile) {
    fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf8');
  }

  return result;
}

module.exports = {
  fileJiraBug
};
