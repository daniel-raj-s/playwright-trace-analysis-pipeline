/**
 * Upsert Analysis Result into DB / Storage
 * Follows exact specifications from BUILD-FROM-SCRATCH.md (Section 5.3).
 * Always exits 0.
 */

const fs = require('fs');
const path = require('path');
const { createErrorFingerprint } = require('../utils/fingerprint');

const VALID_CLASSIFICATIONS = ['real_bug', 'flaky_test', 'env_issue', 'test_maintenance', 'data_issue', 'unknown'];
const VALID_CONFIDENCES = ['high', 'medium', 'low', 'none'];

function clamp(val, maxLen) {
  if (val === null || val === undefined) return null;
  return String(val).slice(0, maxLen);
}

async function insertAnalysisResult(options) {
  try {
    const {
      analysisFile,
      testPath,
      errorMessage,
      executionId,
      buildNumber = 1,
      buildUrl = '',
      environment = 'production',
      category = 'PRODUCTION',
      htmlReportUrl = '',
      slackChannelId = '',
      slackMessageTs = '',
      alertThreadTs = '',
      jenkinsColor = 'lime',
      dbFile = null
    } = options;

    let analysis = {};
    if (analysisFile && fs.existsSync(analysisFile)) {
      analysis = JSON.parse(fs.readFileSync(analysisFile, 'utf8'));
    }

    const classification = VALID_CLASSIFICATIONS.includes(analysis.classification)
      ? analysis.classification
      : 'unknown';

    const confidence = VALID_CONFIDENCES.includes(analysis.confidence)
      ? analysis.confidence
      : 'low';

    const errorFingerprint = errorMessage ? createErrorFingerprint(errorMessage) : null;
    const llmStats = analysis.llmStats || {};

    const record = {
      buildNumber: parseInt(buildNumber, 10) || 1,
      buildUrl: clamp(buildUrl, 500),
      sessionId: clamp(llmStats.session_id, 64),
      testcaseName: clamp(testPath, 500),
      executionId: clamp(executionId, 255),
      environment: clamp(environment, 32),
      category: clamp(category, 32),
      errorMessage: errorMessage ? String(errorMessage).slice(0, 10000) : null,
      errorFingerprint: errorFingerprint ? clamp(errorFingerprint, 200) : null,
      classification,
      confidence,
      casualSummary: clamp(analysis.casualSummary, 280),
      rootCause: Array.isArray(analysis.rootCause) ? analysis.rootCause.join('\n') : analysis.rootCause,
      suspectedPR: clamp(analysis.suspectedPR, 500),
      breakingChange: analysis.breakingChange,
      affectedComponent: clamp(analysis.affectedComponent, 255),
      trendAnalysis: Array.isArray(analysis.trendAnalysis) ? analysis.trendAnalysis.join('\n') : analysis.trendAnalysis,
      chosenScreenshotFile: clamp(analysis.chosenScreenshotFile, 500),
      relatedLinks: JSON.stringify(analysis.relatedLinks || []),
      htmlReportUrl: clamp(htmlReportUrl, 500),
      slackChannelId: clamp(slackChannelId, 32),
      slackMessageTs: clamp(slackMessageTs, 32),
      parentThreadTs: clamp(alertThreadTs, 32),
      jenkinsColor: clamp(jenkinsColor, 16),
      llmModel: clamp(llmStats.model, 128),
      llmCostUsd: llmStats.cost_usd || 0.0,
      llmTurns: llmStats.num_turns || 0,
      llmDurationMs: llmStats.duration_ms || 0,
      startTime: new Date().toISOString()
    };

    // Save to local cache file
    const storePath = dbFile || path.join(process.cwd(), '.trace-db-cache.json');
    let localData = { failures: [], analyses: [] };
    if (fs.existsSync(storePath)) {
      try {
        localData = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      } catch (e) {}
    }

    // Upsert on (buildNumber, testcaseName)
    const existingIndex = localData.analyses.findIndex(
      a => a.buildNumber === record.buildNumber && a.testcaseName === record.testcaseName
    );

    if (existingIndex >= 0) {
      localData.analyses[existingIndex] = { ...localData.analyses[existingIndex], ...record };
    } else {
      localData.analyses.push(record);
    }

    fs.writeFileSync(storePath, JSON.stringify(localData, null, 2), 'utf8');

    // If MySQL is configured, execute UPSERT
    const dbHost = process.env.E2E_RDS_HOSTNAME || process.env.DB_HOST;
    if (dbHost) {
      try {
        const mysql = require('mysql2/promise') || require('mysql/promise');
        const conn = await mysql.createConnection({
          host: dbHost,
          port: parseInt(process.env.E2E_RDS_PORT || process.env.DB_PORT || '3306', 10),
          user: process.env.E2E_RDS_LOGIN_USR || process.env.DB_USER,
          password: process.env.E2E_RDS_LOGIN_PSW || process.env.DB_PASSWORD,
          database: process.env.E2E_RDS_DATABASE || process.env.DB_NAME || 'e2e'
        });

        const sql = `
          INSERT INTO trace_analysis_results (
            buildNumber, buildUrl, sessionId, testcaseName, executionId, environment, category,
            errorMessage, errorFingerprint, classification, confidence, casualSummary, rootCause,
            suspectedPR, breakingChange, affectedComponent, trendAnalysis, chosenScreenshotFile,
            relatedLinks, htmlReportUrl, slackChannelId, slackMessageTs, parentThreadTs, jenkinsColor,
            llmModel, llmCostUsd, llmTurns, llmDurationMs, startTime, endTime
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
          ON DUPLICATE KEY UPDATE
            buildUrl = VALUES(buildUrl),
            sessionId = VALUES(sessionId),
            classification = VALUES(classification),
            confidence = VALUES(confidence),
            casualSummary = VALUES(casualSummary),
            rootCause = VALUES(rootCause),
            suspectedPR = VALUES(suspectedPR),
            breakingChange = VALUES(breakingChange),
            affectedComponent = VALUES(affectedComponent),
            trendAnalysis = VALUES(trendAnalysis),
            chosenScreenshotFile = VALUES(chosenScreenshotFile),
            relatedLinks = VALUES(relatedLinks),
            htmlReportUrl = VALUES(htmlReportUrl),
            slackChannelId = VALUES(slackChannelId),
            slackMessageTs = VALUES(slackMessageTs),
            parentThreadTs = VALUES(parentThreadTs),
            jenkinsColor = VALUES(jenkinsColor),
            llmModel = VALUES(llmModel),
            llmCostUsd = VALUES(llmCostUsd),
            llmTurns = VALUES(llmTurns),
            llmDurationMs = VALUES(llmDurationMs),
            endTime = NOW()
        `;

        await conn.execute(sql, [
          record.buildNumber, record.buildUrl, record.sessionId, record.testcaseName, record.executionId,
          record.environment, record.category, record.errorMessage, record.errorFingerprint, record.classification,
          record.confidence, record.casualSummary, record.rootCause, record.suspectedPR, record.breakingChange,
          record.affectedComponent, record.trendAnalysis, record.chosenScreenshotFile, record.relatedLinks,
          record.htmlReportUrl, record.slackChannelId, record.slackMessageTs, record.parentThreadTs, record.jenkinsColor,
          record.llmModel, record.llmCostUsd, record.llmTurns, record.llmDurationMs
        ]);

        await conn.end();
      } catch (err) {
        console.warn('MySQL insert skipped or failed:', err.message);
      }
    }

    return true;
  } catch (err) {
    console.warn('insertAnalysisResult failed (non-fatal):', err.message);
    return false;
  }
}

// CLI handler - ALWAYS exits 0
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

  insertAnalysisResult(options)
    .then(() => process.exit(0))
    .catch(() => process.exit(0));
}

module.exports = {
  insertAnalysisResult
};

