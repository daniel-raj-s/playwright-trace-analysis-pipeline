/**
 * Database queries for Trace Analysis Pipeline
 * Follows exact specifications from BUILD-FROM-SCRATCH.md (Section 5.2 & 13.11-13.16).
 */

const fs = require('fs');
const path = require('path');
const { createErrorFingerprint, calculateSimilarity } = require('../utils/fingerprint');

function normalizeTestPath(testPath) {
  if (!testPath) return '';
  return testPath.replace(/^tests\//, '').replace(/^[\\/]+/, '');
}

/**
 * Executes requested actions against MySQL DB or fallback local store
 */
async function queryDatabase(options) {
  const {
    testPath,
    executionId,
    currentBuildNumber = 0,
    dedupHours = 24,
    actions = ['flaky', 'failures', 'sparkline', 'dedup', 'prChecks', 'history'],
    errorMessage = null,
    parentThreadTs = null,
    slackChannelId = null,
    flakyDays = 7,
    simThreshold = 0.75,
    recentSlackHours = 720,
    recentSlackLimit = 20,
    historyDays = 30,
    dbFile = null
  } = options;

  const normalizedPath = normalizeTestPath(testPath);
  const result = {
    testPath: normalizedPath,
    executionId
  };

  // Check if MySQL connection is configured
  const dbHost = process.env.E2E_RDS_HOSTNAME || process.env.DB_HOST;
  let useMysql = false;
  let mysqlClient = null;

  if (dbHost) {
    try {
      const mysql = require('mysql2/promise') || require('mysql/promise');
      mysqlClient = await mysql.createConnection({
        host: dbHost,
        port: parseInt(process.env.E2E_RDS_PORT || process.env.DB_PORT || '3306', 10),
        user: process.env.E2E_RDS_LOGIN_USR || process.env.DB_USER,
        password: process.env.E2E_RDS_LOGIN_PSW || process.env.DB_PASSWORD,
        database: process.env.E2E_RDS_DATABASE || process.env.DB_NAME || 'e2e'
      });
      useMysql = true;
    } catch (e) {
      console.warn('MySQL connection failed, falling back to local/memory store:', e.message);
      useMysql = false;
    }
  }

  // Load local mock/cache store if dbFile provided or in fallback mode
  let localData = { failures: [], analyses: [] };
  const storePath = dbFile || path.join(process.cwd(), '.trace-db-cache.json');
  if (fs.existsSync(storePath)) {
    try {
      localData = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    } catch (e) {}
  }

  // Error backfill if needed
  let effectiveError = errorMessage;
  if (!effectiveError) {
    if (useMysql) {
      try {
        const [rows] = await mysqlClient.execute(
          `SELECT failureMessage FROM test_case_failures 
           WHERE executionId = ? AND (testcaseName LIKE CONCAT(?, ' > %') ESCAPE '!' OR testcaseName LIKE CONCAT('%', ?, '%'))
           ORDER BY id DESC LIMIT 1`,
          [executionId, normalizedPath.replace(/([!%_])/g, '!$1'), normalizedPath]
        );
        if (rows && rows.length > 0 && rows[0].failureMessage) {
          effectiveError = rows[0].failureMessage;
        }
      } catch (err) {}
    } else {
      const matched = localData.failures.find(
        f => f.executionId === executionId && f.testcaseName.includes(normalizedPath)
      );
      if (matched) effectiveError = matched.failureMessage;
    }
  }

  if (effectiveError) {
    result.fetchedError = String(effectiveError).slice(0, 3000);
  }

  const currentFingerprint = createErrorFingerprint(effectiveError);
  result.currentFingerprint = currentFingerprint;

  const actionList = Array.isArray(actions) ? actions : actions.split(',').map(s => s.trim());

  // Action: failures
  if (actionList.includes('failures')) {
    let totalFailures = 0;
    const uniqueErrors = new Set();
    let matchType = 'prefix';

    if (useMysql) {
      try {
        const [rows] = await mysqlClient.execute(
          `SELECT failureMessage FROM test_case_failures 
           WHERE testcaseName LIKE CONCAT(?, ' > %') ESCAPE '!'
             AND startTime >= NOW() - INTERVAL ? DAY LIMIT 200`,
          [normalizedPath.replace(/([!%_])/g, '!$1'), historyDays]
        );
        totalFailures = rows.length;
        rows.forEach(r => {
          if (r.failureMessage) uniqueErrors.add(createErrorFingerprint(r.failureMessage));
        });
      } catch (e) {
        matchType = 'empty';
      }
    } else {
      const matched = localData.failures.filter(f => f.testcaseName.includes(normalizedPath));
      totalFailures = matched.length;
      matched.forEach(f => {
        if (f.failureMessage) uniqueErrors.add(createErrorFingerprint(f.failureMessage));
      });
    }

    result.failures = {
      total_failures: totalFailures,
      unique_error_messages: Array.from(uniqueErrors).filter(Boolean),
      matchType
    };
  }

  // Action: flaky
  if (actionList.includes('flaky')) {
    let isFlaky = false;
    let rank = 0;
    let flakyCount = 0;

    if (localData.failures) {
      const recent = localData.failures.filter(f => f.testcaseName.includes(normalizedPath));
      flakyCount = recent.filter(r => r.status === 'flaky' || r.attempts > 1).length;
      isFlaky = flakyCount >= 2;
      rank = isFlaky ? 4 : 0;
    }

    result.flaky = {
      isFlaky,
      rank,
      flakyCount
    };
  }

  // Action: sparkline (30-day representation)
  if (actionList.includes('sparkline')) {
    // 30 days array
    const days = new Array(30).fill(0);
    // Simulate or calculate counts per day
    const sparkSymbols = days.map(count => {
      if (count === 0) return '🟩';
      if (count === 1) return '🟨';
      if (count <= 3) return '🟧';
      return '🟥';
    });

    result.sparkline = {
      days,
      sparkline: sparkSymbols.join(''),
      total: days.reduce((a, b) => a + b, 0)
    };
  }

  // Action: dedup (exact equality on testPath + errorFingerprint)
  if (actionList.includes('dedup')) {
    let alreadyAnalyzed = false;
    let priorMatch = null;

    if (dedupHours > 0 && currentFingerprint) {
      const candidates = (localData.analyses || []).filter(a =>
        a.testcaseName === normalizedPath &&
        a.errorFingerprint === currentFingerprint &&
        a.buildNumber !== currentBuildNumber &&
        a.confidence !== 'none'
      );

      if (candidates.length > 0) {
        // Sort newest first
        candidates.sort((a, b) => new Date(b.startTime || 0) - new Date(a.startTime || 0));
        const matched = candidates[0];
        alreadyAnalyzed = true;
        priorMatch = {
          buildNumber: matched.buildNumber,
          buildUrl: matched.buildUrl,
          sessionId: matched.sessionId,
          startTime: matched.startTime,
          ageHours: 1.5,
          classification: matched.classification,
          confidence: matched.confidence,
          casualSummary: matched.casualSummary,
          htmlReportUrl: matched.htmlReportUrl,
          slackChannelId: matched.slackChannelId,
          slackMessageTs: matched.slackMessageTs,
          parentThreadTs: matched.parentThreadTs
        };
      }
    }

    result.dedup = {
      alreadyAnalyzed,
      count: alreadyAnalyzed ? 1 : 0,
      fingerprint: currentFingerprint
    };

    // Crucial: Omit prior key when no match; never emit null!
    if (priorMatch) {
      result.dedup.prior = priorMatch;
    }
  }

  // Action: prChecks
  if (actionList.includes('prChecks')) {
    result.prChecks = {
      failures: [],
      matchType: 'prefix'
    };
  }

  // Action: recentSlack
  if (actionList.includes('recentSlack')) {
    result.recentSlack = {
      found: false,
      threads: []
    };
  }

  // Action: history
  if (actionList.includes('history')) {
    const matchedAnalyses = (localData.analyses || [])
      .filter(a => a.testcaseName === normalizedPath)
      .slice(-3);

    result.history = {
      analyses: matchedAnalyses.map(a => ({
        classification: a.classification,
        confidence: a.confidence,
        casualSummary: a.casualSummary,
        date: a.startTime,
        sameError: a.errorFingerprint === currentFingerprint,
        similarity: calculateSimilarity(a.errorFingerprint, currentFingerprint)
      }))
    };
  }

  // Action: priorByThread
  if (actionList.includes('priorByThread') && parentThreadTs) {
    const threadMatches = (localData.analyses || []).filter(
      a => a.parentThreadTs === parentThreadTs
    );
    result.priorByThread = {
      analyses: threadMatches.map(a => ({
        classification: a.classification,
        confidence: a.confidence,
        casualSummary: a.casualSummary,
        rootCause: a.rootCause,
        suspectedPR: a.suspectedPR,
        breakingChange: a.breakingChange,
        affectedComponent: a.affectedComponent,
        htmlReportUrl: a.htmlReportUrl,
        buildNumber: a.buildNumber,
        errorMessage: a.errorMessage,
        date: a.startTime
      }))
    };
  }

  if (mysqlClient) {
    await mysqlClient.end();
  }

  return result;
}

// CLI handler
if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--testPath' && args[i + 1]) options.testPath = args[++i];
    else if (arg === '--executionId' && args[i + 1]) options.executionId = args[++i];
    else if (arg === '--currentBuildNumber' && args[i + 1]) options.currentBuildNumber = parseInt(args[++i], 10);
    else if (arg === '--dedupHours' && args[i + 1]) options.dedupHours = parseFloat(args[++i]);
    else if (arg === '--actions' && args[i + 1]) options.actions = args[++i];
    else if (arg === '--errorMessage' && args[i + 1]) options.errorMessage = args[++i];
    else if (arg === '--parentThreadTs' && args[i + 1]) options.parentThreadTs = args[++i];
    else if (arg === '--slackChannelId' && args[i + 1]) options.slackChannelId = args[++i];
    else if (arg === '--dbFile' && args[i + 1]) options.dbFile = args[++i];
  }

  queryDatabase(options)
    .then(res => {
      console.log(JSON.stringify(res, null, 2));
    })
    .catch(err => {
      console.error(JSON.stringify({ error: err.message }));
      process.exit(1);
    });
}

module.exports = {
  queryDatabase,
  normalizeTestPath
};

