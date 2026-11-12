/**
 * Run Version Resolver & Fix Verifier
 * Follows exact specifications from BUILD-FROM-SCRATCH.md (Section 5.7).
 */

const fs = require('fs');
const path = require('path');

/**
 * Resolves the commit that ran the test
 */
async function resolveRunVersion(options) {
  const {
    testPath,
    testCodeSha = null,
    reportFile = null,
    outputFile = null,
    githubToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  } = options;

  let sha = testCodeSha;
  let source = 'validator';

  // Validate hex SHA (7 to 40 chars)
  const isValidHex = sha && /^[0-9a-f]{7,40}$/i.test(sha);
  if (!isValidHex) {
    if (sha) {
      console.warn(`Ignoring non-hex TEST_CODE_SHA: ${sha}`);
    }
    sha = null;
    source = 'report';

    // Attempt to read from report file if provided
    if (reportFile && fs.existsSync(reportFile)) {
      try {
        const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
        sha = report.version || report.commitSha || null;
      } catch (e) {}
    }
  }

  const result = {
    status: 'ok',
    app: testPath ? testPath.split('/')[0] : 'web',
    sha: sha || 'unknown',
    source,
    commit: {
      headline: null,
      prNumber: null,
      committedAt: null
    }
  };

  if (!sha || sha === 'unknown') {
    result.status = 'unknown_sha';
  } else if (githubToken) {
    try {
      const repo = process.env.GITHUB_REPOSITORY || 'organization/repository';
      const res = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}`, {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          'User-Agent': 'trace-analysis-pipeline',
          Accept: 'application/vnd.github.v3+json'
        }
      });

      if (res.status === 404 || res.status === 422) {
        result.status = 'unknown_sha';
      } else if (res.ok) {
        const data = await res.json();
        const headline = data.commit?.message?.split('\n')[0] || '';
        const prMatch = headline.match(/#(\d+)/);
        result.commit = {
          headline,
          prNumber: prMatch ? parseInt(prMatch[1], 10) : null,
          committedAt: data.commit?.committer?.date || null
        };
      }
    } catch (e) {
      result.status = 'skipped';
      result.reason = e.message;
    }
  }

  if (outputFile) {
    fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf8');
  }

  return result;
}

/**
 * Verifies if candidate fix PR was present in the test run
 */
async function verifyFixAgainstRun(options) {
  const {
    testPath,
    runVersionFile,
    analysisFile,
    githubToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  } = options;

  let runVersion = { sha: 'unknown' };
  if (runVersionFile && fs.existsSync(runVersionFile)) {
    try {
      runVersion = JSON.parse(fs.readFileSync(runVersionFile, 'utf8'));
    } catch (e) {}
  }

  let analysis = {};
  if (analysisFile && fs.existsSync(analysisFile)) {
    try {
      analysis = JSON.parse(fs.readFileSync(analysisFile, 'utf8'));
    } catch (e) {}
  }

  const runSha = runVersion.sha;
  const existingFix = analysis.existingFix || '';

  // Extract PR candidates (max 3)
  const prMatches = existingFix.match(/#(\d+)/g) || [];
  const fixPrNumbers = prMatches.map(m => parseInt(m.replace('#', ''), 10)).slice(0, 3);

  const checkResult = {
    status: 'no_fix_named',
    run: { sha: runSha },
    checked: [],
    fix: null,
    title: '',
    message: ''
  };

  if (!runSha || runSha === 'unknown' || fixPrNumbers.length === 0 || !githubToken) {
    if (fixPrNumbers.length === 0) checkResult.status = 'no_fix_named';
    else if (!githubToken) checkResult.status = 'skipped';
    else checkResult.status = 'inconclusive';

    analysis.versionCheck = checkResult;
    if (analysisFile) {
      fs.writeFileSync(analysisFile, JSON.stringify(analysis, null, 2), 'utf8');
    }
    return checkResult;
  }

  const repo = process.env.GITHUB_REPOSITORY || 'organization/repository';

  for (const prNum of fixPrNumbers) {
    try {
      const prRes = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNum}`, {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          'User-Agent': 'trace-analysis-pipeline',
          Accept: 'application/vnd.github.v3+json'
        }
      });

      if (!prRes.ok) continue;
      const prData = await prRes.json();

      if (!prData.merged_at || !prData.merge_commit_sha) {
        checkResult.checked.push({ pr: prNum, merged: false });
        continue;
      }

      const fixMergeSha = prData.merge_commit_sha;

      // Compare commits
      const cmpRes = await fetch(`https://api.github.com/repos/${repo}/compare/${fixMergeSha}...${runSha}`, {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          'User-Agent': 'trace-analysis-pipeline',
          Accept: 'application/vnd.github.v3+json'
        }
      });

      if (!cmpRes.ok) continue;
      const cmpData = await cmpRes.json();

      const relation = cmpData.status; // behind, ahead, identical, diverged
      const behindBy = cmpData.behind_by || 0;

      const checkedEntry = {
        pr: prNum,
        merged: true,
        mergeSha: fixMergeSha,
        mergedAt: prData.merged_at,
        relation,
        behindBy
      };
      checkResult.checked.push(checkedEntry);

      if (relation === 'behind') {
        checkResult.status = 'fix_not_in_run';
        checkResult.fix = checkedEntry;
        checkResult.title = 'Ran on older test code';
        checkResult.message = `Test ran at commit ${runSha.slice(0, 7)}. Fix #${prNum} merged ${behindBy} commit(s) later, so the run did not have the fix.`;
        break;
      } else if (relation === 'ahead' || relation === 'identical') {
        checkResult.status = 'fix_in_run';
        checkResult.fix = checkedEntry;
        checkResult.title = `#${prNum} was already in the code that failed`;
        checkResult.message = `Fix #${prNum} was merged prior to run commit ${runSha.slice(0, 7)} but the test still failed.`;
      }
    } catch (e) {
      console.warn(`PR check failed for #${prNum}:`, e.message);
    }
  }

  if (checkResult.status === 'fix_in_run') {
    analysis.supersededExistingFix = analysis.existingFix;
    analysis.existingFix = null;
  }

  analysis.versionCheck = checkResult;

  if (analysisFile) {
    fs.writeFileSync(analysisFile, JSON.stringify(analysis, null, 2), 'utf8');
  }

  return checkResult;
}

// CLI handler
if (require.main === module) {
  const mode = process.argv[2];
  const args = process.argv.slice(3);
  const options = {};

  for (let i = 0; i < args.length; i++) {
    const k = args[i].replace(/^--/, '');
    const v = args[i + 1];
    if (v && !v.startsWith('--')) {
      options[k] = v;
      i++;
    }
  }

  if (mode === 'resolve') {
    resolveRunVersion(options)
      .then(r => console.log(JSON.stringify(r, null, 2)))
      .catch(e => {
        console.error(e);
        process.exit(1);
      });
  } else if (mode === 'verify') {
    verifyFixAgainstRun(options)
      .then(r => console.log(JSON.stringify(r, null, 2)))
      .catch(e => {
        console.error(e);
        process.exit(1);
      });
  } else {
    console.error('Usage: node run-version.js <resolve|verify> [options]');
    process.exit(1);
  }
}

module.exports = {
  resolveRunVersion,
  verifyFixAgainstRun
};

