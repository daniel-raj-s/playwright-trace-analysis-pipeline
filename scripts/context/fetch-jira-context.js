/**
 * Fetch Jira Context & Issue Search
 * Follows exact specifications from BUILD-FROM-SCRATCH.md (Section 5.6).
 */

const fs = require('fs');

function extractAppName(testPath) {
  if (!testPath) return 'unknown';
  const parts = testPath.replace(/\\/g, '/').split('/');
  const ignored = new Set(['integration', 'playwright', 'tests', 'apps', 'src']);
  for (const part of parts) {
    if (!ignored.has(part.toLowerCase()) && part.length > 1) {
      return part;
    }
  }
  return parts[0] || 'app';
}

async function fetchJiraContext(options) {
  const {
    testPath,
    errorMessage = '',
    outputFile = null
  } = options;

  const appName = extractAppName(testPath);
  const testName = testPath ? testPath.split('/').pop().replace(/\.(test|spec)\.[jt]sx?$/, '') : '';

  const jql = `project = QA AND text ~ "${appName}" AND text ~ "${testName}" ORDER BY updated DESC`;

  const result = {
    appName,
    testName,
    jql,
    restStatus: 'no-credentials',
    relatedIssues: []
  };

  const jiraEmail = process.env.QE_JIRA_EMAIL || process.env.JIRA_EMAIL;
  const jiraToken = process.env.QE_JIRA_KEY || process.env.JIRA_API_TOKEN;
  const jiraHost = process.env.JIRA_HOST || 'your-company.atlassian.net';

  if (jiraEmail && jiraToken) {
    try {
      const auth = Buffer.from(`${jiraEmail}:${jiraToken}`).toString('base64');
      const url = `https://${jiraHost}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=5`;

      const res = await fetch(url, {
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: 'application/json'
        }
      });

      if (res.ok) {
        const data = await res.json();
        result.restStatus = (data.issues && data.issues.length > 0) ? 'ok' : 'no-results';
        result.relatedIssues = (data.issues || []).map(i => ({
          key: i.key,
          summary: i.fields?.summary || '',
          status: i.fields?.status?.name || '',
          type: i.fields?.issuetype?.name || '',
          priority: i.fields?.priority?.name || '',
          updated: i.fields?.updated || '',
          url: `https://${jiraHost}/browse/${i.key}`
        }));
      } else {
        result.restStatus = `error: HTTP ${res.status}`;
      }
    } catch (e) {
      result.restStatus = `error: ${e.message}`;
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
    if (args[i] === '--testPath' && args[i + 1]) options.testPath = args[++i];
    if (args[i] === '--errorMessage' && args[i + 1]) options.errorMessage = args[++i];
    if (args[i] === '--output' && args[i + 1]) options.outputFile = args[++i];
  }

  fetchJiraContext(options)
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}

module.exports = {
  fetchJiraContext,
  extractAppName
};

