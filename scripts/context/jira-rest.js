/**
 * Jira REST Read-Only Client
 * Follows exact specifications from BUILD-FROM-SCRATCH.md (Section 5.6).
 * Never contains write methods.
 */

async function searchJira(jql, maxResults = 10) {
  const email = process.env.QE_JIRA_EMAIL || process.env.JIRA_EMAIL;
  const token = process.env.QE_JIRA_KEY || process.env.JIRA_API_TOKEN;
  const host = process.env.JIRA_HOST || 'your-company.atlassian.net';

  if (!email || !token) {
    throw new Error('Missing Jira credentials');
  }

  const auth = Buffer.from(`${email}:${token}`).toString('base64');
  const res = await fetch(`https://${host}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}`, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json'
    }
  });

  if (!res.ok) {
    throw new Error(`Jira search error HTTP ${res.status}`);
  }

  return await res.json();
}

async function getIssue(issueKey) {
  const email = process.env.QE_JIRA_EMAIL || process.env.JIRA_EMAIL;
  const token = process.env.QE_JIRA_KEY || process.env.JIRA_API_TOKEN;
  const host = process.env.JIRA_HOST || 'your-company.atlassian.net';

  if (!email || !token) {
    throw new Error('Missing Jira credentials');
  }

  const auth = Buffer.from(`${email}:${token}`).toString('base64');
  const res = await fetch(`https://${host}/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json'
    }
  });

  if (!res.ok) {
    throw new Error(`Jira getIssue error HTTP ${res.status}`);
  }

  return await res.json();
}

if (require.main === module) {
  const command = process.argv[2];
  if (command === 'search') {
    const jql = process.argv[3] || 'project = QA';
    searchJira(jql)
      .then(r => console.log(JSON.stringify(r, null, 2)))
      .catch(e => { console.error(e.message); process.exit(1); });
  } else if (command === 'get') {
    const key = process.argv[3];
    getIssue(key)
      .then(r => console.log(JSON.stringify(r, null, 2)))
      .catch(e => { console.error(e.message); process.exit(1); });
  } else {
    console.log('Usage: node jira-rest.js <search|get> [args]');
  }
}

module.exports = {
  searchJira,
  getIssue
};

