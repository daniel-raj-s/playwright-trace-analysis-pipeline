#!/usr/bin/env node
/**
 * Autonomous Playwright Trace Analysis Pipeline Runner
 * 
 * Works seamlessly in GitHub Actions (GHA) and local environments.
 * Supports any AI Model (OpenAI, Gemini, Anthropic, Ollama, Mock).
 * 
 * Follows exact specifications from BUILD-FROM-SCRATCH.md.
 */

const fs = require('fs');
const path = require('path');
const { extractFailures } = require('../trace/extract-trace-failures');
const { queryDatabase, normalizeTestPath } = require('../db/db-queries');
const { insertAnalysisResult } = require('../db/insert-analysis-result');
const { resolveRunVersion, verifyFixAgainstRun } = require('../context/run-version');
const { fetchSlackContext } = require('../context/fetch-slack-context');
const { fetchJiraContext } = require('../context/fetch-jira-context');
const { buildPrompt } = require('../llm/build-prompt');
const { invokeModel } = require('../llm/invoke-llm');
const { parseLlmResponse } = require('../llm/parse-llm-response');
const { buildHtmlReport } = require('../notification/build-html-report');
const { buildGhaSummary } = require('../notification/build-gha-summary');
const { buildSlackBlocks } = require('../notification/build-slack-blocks');
const { buildReuseBlocks } = require('../notification/build-reuse-blocks');
const { postSlack } = require('../notification/post-slack');
const { postGitHubComment } = require('../notification/post-github-comment');

function slugify(testPath) {
  return String(testPath || 'unknown').replace(/[^a-zA-Z0-9]/g, '_');
}

async function runPipeline(options) {
  const startTime = Date.now();
  console.log('🚀 Starting Playwright Trace Analysis Pipeline...');

  const {
    trace = null,
    test = null,
    executionName = `gha-e2e-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}.1200`,
    environment = process.env.ENVIRONMENT || 'production',
    category = process.env.CATEGORY || 'PRODUCTION',
    buildNumber = process.env.GITHUB_RUN_NUMBER || '1',
    buildUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : 'local',
    provider = process.env.LLM_PROVIDER || 'auto',
    model = process.env.LLM_MODEL || null,
    testCodeSha = process.env.TEST_CODE_SHA || process.env.GITHUB_SHA || '',
    dedupHours = parseFloat(process.env.DEDUP_HOURS || '24'),
    workDir = path.join(process.cwd(), 'work-artifacts'),
    loopTotal = parseInt(process.env.LOOP_TOTAL || '0', 10),
    loopFailed = parseInt(process.env.LOOP_FAILED || '0', 10),
    errorMessage = process.env.RAW_ERROR_MESSAGES || null,
    alertThreadTs = process.env.ALERT_THREAD_TS || null,
    alertChannelId = process.env.ALERT_CHANNEL_ID || null,
    slackToken = process.env.SLACK_BOT_TOKEN || null,
    postPrComment = process.env.PR_NOTIFY === 'on' || !!process.env.PR_NUMBER,
    dbFile = options.dbFile || null
  } = options;

  if (!trace) {
    throw new Error('Missing required parameter: --trace <path-to-trace.zip-or-folder>');
  }

  const normalizedTest = normalizeTestPath(test || path.basename(trace, '.zip'));
  const slug = slugify(normalizedTest);
  const testWorkDir = path.join(workDir, slug);
  fs.mkdirSync(testWorkDir, { recursive: true });

  const ctx = {
    testPath: normalizedTest,
    workDir: testWorkDir,
    dbResultFile: path.join(testWorkDir, 'db-result.json'),
    traceOutDir: path.join(testWorkDir, 'trace-out'),
    traceFile: path.join(testWorkDir, 'trace-out', 'failure-extract.json'),
    runVersionFile: path.join(testWorkDir, 'run-version.json'),
    slackContextFile: path.join(testWorkDir, 'slack-context.json'),
    jiraContextFile: path.join(testWorkDir, 'jira-context.json'),
    promptFile: path.join(testWorkDir, 'prompt.txt'),
    llmRawFile: path.join(testWorkDir, 'llm-output.json'),
    analysisFile: path.join(testWorkDir, 'analysis-result.json'),
    htmlFile: path.join(testWorkDir, 'report.html'),
    ghaSummaryFile: path.join(testWorkDir, 'summary.md'),
    mainBlocksFile: path.join(testWorkDir, 'main-blocks.json'),
    postResultFile: path.join(testWorkDir, 'post-result.json')
  };

  console.log(`📂 Working directory initialized: ${testWorkDir}`);

  // 1. Extract Trace Data First (so errors, screenshots, and logs are immediately available)
  console.log(`⏱ [1/7] Extracting Playwright trace: ${trace}...`);
  const traceData = extractFailures(trace, ctx.traceOutDir, { test: normalizedTest });
  console.log(`   Processed ${traceData.traces.length} trace(s), found ${traceData.summary.totalFailedNetworkRequests} failed network request(s), ${traceData.summary.totalScreenshots} screenshot(s).`);

  const effectiveError = errorMessage || (traceData.traces?.[0]?.actions?.failedActions?.[0]?.error) || null;

  // 2. Query Database & History (with exact error fingerprint)
  console.log('⏱ [2/7] Querying failure history and checking deduplication...');
  const dbResult = await queryDatabase({
    testPath: normalizedTest,
    executionId: executionName,
    currentBuildNumber: parseInt(buildNumber, 10),
    dedupHours,
    errorMessage: effectiveError,
    dbFile
  });
  fs.writeFileSync(ctx.dbResultFile, JSON.stringify(dbResult, null, 2), 'utf8');

  // Check Deduplication Reuse Gate
  if (dbResult.dedup?.alreadyAnalyzed && dbResult.dedup.prior) {
    console.log(`↪ Dedup hit: Exact error match found from build #${dbResult.dedup.prior.buildNumber}. Reusing verdict.`);
    const priorFile = path.join(testWorkDir, 'prior-hit.json');
    fs.writeFileSync(priorFile, JSON.stringify(dbResult.dedup.prior, null, 2), 'utf8');

    buildReuseBlocks({
      testPath: normalizedTest,
      priorFile,
      outputFile: ctx.mainBlocksFile
    });

    if (slackToken) {
      await postSlack({
        token: slackToken,
        mainBlocksFile: ctx.mainBlocksFile,
        alertThreadTs,
        alertChannelId
      });
    }

    console.log('✅ Reused existing verdict successfully (no LLM tokens spent).');
    return { status: 'reused', prior: dbResult.dedup.prior };
  }

  // 3. Collect External Context
  console.log('⏱ [3/7] Collecting git commit version & external context...');
  await resolveRunVersion({
    testPath: normalizedTest,
    testCodeSha,
    outputFile: ctx.runVersionFile
  });

  await fetchSlackContext({
    outputFile: ctx.slackContextFile
  });

  await fetchJiraContext({
    testPath: normalizedTest,
    errorMessage: dbResult.fetchedError || errorMessage,
    outputFile: ctx.jiraContextFile
  });

  // 4. Build Prompt
  console.log('⏱ [4/7] Assembling 11-section investigation prompt...');
  const systemPromptPath = path.join(__dirname, '..', '..', 'prompts', 'analysis-prompt.md');
  const userPrompt = buildPrompt({
    testPath: normalizedTest,
    category,
    environment,
    executionName,
    loopTotal,
    loopFailed,
    testCodeSha,
    runVersionFile: ctx.runVersionFile,
    dbResultFile: ctx.dbResultFile,
    traceFile: ctx.traceFile,
    errorMessage: dbResult.fetchedError || errorMessage,
    slackContextFile: ctx.slackContextFile,
    jiraContextFile: ctx.jiraContextFile,
    screenshotsBaseUrl: './screenshots/'
  });
  fs.writeFileSync(ctx.promptFile, userPrompt, 'utf8');

  // 5. Invoke AI Model
  console.log(`⏱ [5/7] Invoking AI Model (Provider: ${provider}, Model: ${model || 'default'})...`);
  await invokeModel({
    promptFile: ctx.promptFile,
    systemPromptFile: systemPromptPath,
    outputFile: ctx.llmRawFile,
    provider,
    model
  });

  // 6. Parse and Validate Response
  console.log('⏱ [6/7] Parsing and validating LLM structured JSON response...');
  const verdict = parseLlmResponse({
    inputFile: ctx.llmRawFile,
    outputFile: ctx.analysisFile,
    mode: 'analysis',
    fallbackModel: model || 'auto'
  });

  // Verify fix PR if named
  await verifyFixAgainstRun({
    testPath: normalizedTest,
    runVersionFile: ctx.runVersionFile,
    analysisFile: ctx.analysisFile
  });

  console.log(`🧠 Verdict: ${verdict.classification.toUpperCase()} (${verdict.confidence} confidence)`);
  console.log(`   Summary: "${verdict.casualSummary}"`);

  // 7. Render Notifications & Artifacts
  console.log('⏱ [7/7] Generating HTML report, GHA summary, and notifications...');
  buildHtmlReport({
    testPath: normalizedTest,
    environment,
    category,
    executionId: executionName,
    buildNumber,
    analysisFile: ctx.analysisFile,
    traceFile: ctx.traceFile,
    outputFile: ctx.htmlFile
  });

  const ghaSummary = buildGhaSummary({
    testPath: normalizedTest,
    environment,
    category,
    executionId: executionName,
    analysisFile: ctx.analysisFile,
    traceFile: ctx.traceFile,
    outputFile: ctx.ghaSummaryFile
  });

  // Append to GitHub Actions summary if running in GHA
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, ghaSummary + '\n\n', 'utf8');
    console.log('   ✓ Appended markdown report to $GITHUB_STEP_SUMMARY');
  }

  // Build Slack Blocks
  buildSlackBlocks({
    testPath: normalizedTest,
    analysisFile: ctx.analysisFile,
    traceFile: ctx.traceFile,
    loopTotal,
    loopFailed,
    traceAnalysisBuildNumber: buildNumber,
    outputFile: ctx.mainBlocksFile
  });

  // Post to Slack if token provided
  if (slackToken) {
    console.log('   Posting card to Slack...');
    await postSlack({
      token: slackToken,
      mainBlocksFile: ctx.mainBlocksFile,
      alertThreadTs,
      alertChannelId,
      outputFile: ctx.postResultFile
    });
  }

  // Post PR comment if requested
  if (postPrComment) {
    console.log('   Posting comment to PR...');
    await postGitHubComment({
      summaryFile: ctx.ghaSummaryFile
    });
  }

  // Persist analysis result
  await insertAnalysisResult({
    analysisFile: ctx.analysisFile,
    testPath: normalizedTest,
    errorMessage: effectiveError,
    executionId: executionName,
    buildNumber,
    buildUrl,
    environment,
    category,
    dbFile
  });

  const durationSec = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n🎉 Analysis completed in ${durationSec}s!`);
  console.log(`   📄 HTML Report: ${ctx.htmlFile}`);
  console.log(`   📊 Analysis JSON: ${ctx.analysisFile}`);

  return {
    status: 'completed',
    verdict,
    artifacts: {
      html: ctx.htmlFile,
      analysisJson: ctx.analysisFile,
      ghaSummary: ctx.ghaSummaryFile,
      slackBlocks: ctx.mainBlocksFile
    }
  };
}

// CLI handler
if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};

  for (let i = 0; i < args.length; i++) {
    const k = args[i].replace(/^--/, '');
    const v = args[i + 1];
    if (v && !v.startsWith('--')) {
      options[k] = v;
      i++;
    } else {
      options[k] = true;
    }
  }

  runPipeline(options)
    .then(() => process.exit(0))
    .catch(err => {
      console.error('\n❌ Pipeline execution failed:', err);
      process.exit(1);
    });
}

module.exports = {
  runPipeline
};
