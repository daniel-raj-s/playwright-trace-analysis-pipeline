-- E2E Test Failures & Trace Analysis Database Schema
-- Compatible with MySQL 5.7+ / 8.0+

CREATE TABLE IF NOT EXISTS test_case_failures (
  id INT AUTO_INCREMENT PRIMARY KEY,
  testcaseName VARCHAR(255) NOT NULL, -- Format: "<file> > <title>" (no leading tests/ prefix)
  status VARCHAR(50) DEFAULT 'failed',
  failureMessage MEDIUMTEXT,
  attempts INT DEFAULT 1,
  executionId VARCHAR(255) NOT NULL,
  startTime DATETIME DEFAULT CURRENT_TIMESTAMP,
  completionTime DATETIME,
  jenkinsExecutionId INT,
  KEY idx_exec (executionId),
  KEY idx_test (testcaseName(100)),
  KEY idx_time (startTime)
);

CREATE TABLE IF NOT EXISTS trace_analysis_results (
  id INT AUTO_INCREMENT PRIMARY KEY,
  buildNumber INT NOT NULL,
  buildUrl VARCHAR(500),
  sessionId VARCHAR(64),
  testcaseName VARCHAR(500) NOT NULL, -- The bare test path
  executionId VARCHAR(255),
  environment VARCHAR(32),
  category VARCHAR(32),
  errorMessage MEDIUMTEXT,
  errorFingerprint VARCHAR(200), -- NULL when no error text (never '')
  classification ENUM('real_bug','flaky_test','env_issue','test_maintenance','data_issue','unknown'),
  confidence ENUM('high','medium','low','none'),
  casualSummary VARCHAR(280),
  rootCause TEXT,
  suspectedPR VARCHAR(500),
  breakingChange TEXT,
  affectedComponent VARCHAR(255),
  trendAnalysis TEXT,
  chosenScreenshotFile VARCHAR(500),
  relatedLinks TEXT, -- JSON array string
  htmlReportUrl VARCHAR(500),
  slackChannelId VARCHAR(32),
  slackMessageTs VARCHAR(32),
  parentThreadTs VARCHAR(32),
  jenkinsColor VARCHAR(16),
  llmModel VARCHAR(128),
  llmCostUsd DECIMAL(10,4),
  llmTurns INT,
  llmDurationMs INT,
  startTime DATETIME DEFAULT CURRENT_TIMESTAMP,
  endTime DATETIME,
  UNIQUE KEY uk_build_test (buildNumber, testcaseName(190)),
  KEY idx_dedup (testcaseName(190), errorFingerprint, startTime),
  KEY idx_thread (parentThreadTs, slackChannelId)
);

