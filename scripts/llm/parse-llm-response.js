/**
 * Parse & Normalize LLM Response with Partial Stream Salvage
 * Follows exact specifications from BUILD-FROM-SCRATCH.md (Section 5.10 & 6.2).
 */

const fs = require('fs');

const VALID_CLASSIFICATIONS = ['real_bug', 'flaky_test', 'env_issue', 'test_maintenance', 'data_issue', 'unknown'];
const VALID_CONFIDENCES = ['high', 'medium', 'low', 'none'];

function extractJsonSubstring(text) {
  if (!text) return null;
  // Strip code block fences
  const cleaned = text.replace(/```(?:json)?/gi, '').replace(/```/g, '');
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }
  return cleaned.slice(firstBrace, lastBrace + 1);
}

function salvagePartialJson(rawText, mode) {
  const salvaged = {
    truncated: true,
    salvagedFromPartialOutput: true
  };

  if (mode === 'analysis') {
    const classMatch = rawText.match(/"classification"\s*:\s*"([^"]+)"/);
    if (classMatch && VALID_CLASSIFICATIONS.includes(classMatch[1])) {
      salvaged.classification = classMatch[1];
    } else {
      salvaged.classification = 'unknown';
    }

    const confMatch = rawText.match(/"confidence"\s*:\s*"([^"]+)"/);
    salvaged.confidence = (confMatch && VALID_CONFIDENCES.includes(confMatch[1])) ? confMatch[1] : 'low';

    const sumMatch = rawText.match(/"casualSummary"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
    salvaged.casualSummary = sumMatch ? sumMatch[1].replace(/\\"/g, '"') : 'Analysis salvaged from partial model output.';

    const rootMatch = rawText.match(/"rootCause"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
    salvaged.rootCause = rootMatch ? rootMatch[1].replace(/\\"/g, '"') : '- Root cause partially extracted from stream';

    salvaged.relatedLinks = [];
    return salvaged;
  } else if (mode === 'question') {
    const ansMatch = rawText.match(/"answer"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
    salvaged.answer = ansMatch ? ansMatch[1].replace(/\\"/g, '"') : 'Answer salvaged from partial output.';
    salvaged.confidence = 'low';
    salvaged.relatedLinks = [];
    return salvaged;
  } else if (mode === 'fix') {
    salvaged.attempted = false;
    salvaged.reason = 'Fix model output was incomplete or truncated.';
    salvaged.filesChanged = [];
    return salvaged;
  }

  return null;
}

function normalizeAnalysis(parsed, llmStats) {
  const classification = VALID_CLASSIFICATIONS.includes(parsed.classification)
    ? parsed.classification
    : 'unknown';

  const confidence = VALID_CONFIDENCES.includes(parsed.confidence)
    ? parsed.confidence
    : 'low';

  const formatBullets = (val) => {
    if (!val) return '';
    if (Array.isArray(val)) {
      return val.map(item => item.startsWith('-') ? item : `- ${item}`).join('\n');
    }
    return String(val);
  };

  const relatedLinks = Array.isArray(parsed.relatedLinks)
    ? parsed.relatedLinks
        .filter(l => l && l.url && /^https?:\/\//i.test(l.url))
        .map(l => ({
          type: String(l.type || 'other').toLowerCase(),
          url: String(l.url),
          title: String(l.title || 'Link').slice(0, 200),
          relevance: String(l.relevance || '').slice(0, 400)
        }))
    : [];

  return {
    reasoning: parsed.reasoning || '',
    classification,
    confidence,
    casualSummary: String(parsed.casualSummary || '').slice(0, 240),
    rootCause: formatBullets(parsed.rootCause),
    trigger: String(parsed.trigger || '').slice(0, 160),
    failingAssertion: String(parsed.failingAssertion || ''),
    suggestedFix: String(parsed.suggestedFix || '').slice(0, 180),
    existingFix: parsed.existingFix ? String(parsed.existingFix).slice(0, 250) : null,
    ruledOut: String(parsed.ruledOut || '').slice(0, 200),
    breakingChange: parsed.breakingChange ? String(parsed.breakingChange) : null,
    suspectedPR: parsed.suspectedPR ? String(parsed.suspectedPR).slice(0, 500) : null,
    relatedLinks,
    affectedComponent: String(parsed.affectedComponent || 'Unknown').slice(0, 255),
    chosenScreenshotFile: parsed.chosenScreenshotFile ? String(parsed.chosenScreenshotFile).slice(0, 500) : null,
    trendAnalysis: formatBullets(parsed.trendAnalysis),
    llmStats
  };
}

function parseLlmResponse(options) {
  const {
    inputFile,
    outputFile,
    mode = 'analysis',
    fallbackModel = 'auto'
  } = options;

  let rawContent = '';
  if (inputFile && fs.existsSync(inputFile)) {
    rawContent = fs.readFileSync(inputFile, 'utf8');
  }

  const llmStats = {
    cost_usd: 0.0,
    num_turns: 1,
    duration_ms: 0,
    session_id: 'unknown',
    model: fallbackModel,
    is_error: false,
    terminal_reason: 'completed'
  };

  let assistantText = '';

  // Extract from JSONL or JSON wrapper
  const lines = rawContent.split('\n').filter(l => l.trim().length > 0);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.cost_usd) llmStats.cost_usd = obj.cost_usd;
      if (obj.num_turns) llmStats.num_turns = obj.num_turns;
      if (obj.duration_ms) llmStats.duration_ms = obj.duration_ms;
      if (obj.session_id) llmStats.session_id = obj.session_id;
      if (obj.model) llmStats.model = obj.model;

      if (obj.result && typeof obj.result === 'string') {
        assistantText = obj.result;
      } else if (obj.type === 'result' && obj.result) {
        assistantText = typeof obj.result === 'string' ? obj.result : JSON.stringify(obj.result);
      } else if (obj.choices?.[0]?.message?.content) {
        assistantText = obj.choices[0].message.content;
      }
    } catch (e) {
      // not JSON line, could be raw text
    }
  }

  if (!assistantText) {
    assistantText = rawContent;
  }

  let finalResult = null;
  const jsonStr = extractJsonSubstring(assistantText);

  if (jsonStr) {
    try {
      const parsed = JSON.parse(jsonStr);
      if (mode === 'analysis') {
        finalResult = normalizeAnalysis(parsed, llmStats);
      } else if (mode === 'question') {
        finalResult = {
          answer: String(parsed.answer || '').slice(0, 2500),
          confidence: VALID_CONFIDENCES.includes(parsed.confidence) ? parsed.confidence : 'medium',
          relatedLinks: Array.isArray(parsed.relatedLinks) ? parsed.relatedLinks.slice(0, 4) : [],
          llmStats
        };
      } else if (mode === 'fix') {
        finalResult = {
          attempted: Boolean(parsed.attempted),
          summary: parsed.summary ? String(parsed.summary).slice(0, 1000) : null,
          filesChanged: Array.isArray(parsed.filesChanged) ? parsed.filesChanged : [],
          prTitle: parsed.prTitle ? String(parsed.prTitle).slice(0, 200) : null,
          prBody: parsed.prBody ? String(parsed.prBody) : null,
          reason: parsed.reason ? String(parsed.reason).slice(0, 2000) : null,
          llmStats
        };
      }
    } catch (parseErr) {
      console.warn('JSON parse error, attempting salvage:', parseErr.message);
    }
  }

  // Salvage if needed
  if (!finalResult) {
    const salvaged = salvagePartialJson(assistantText, mode);
    if (salvaged) {
      llmStats.salvagedFromPartialOutput = true;
      if (mode === 'analysis') {
        finalResult = normalizeAnalysis(salvaged, llmStats);
      } else {
        finalResult = { ...salvaged, llmStats };
      }
    }
  }

  // Total fallback
  if (!finalResult) {
    llmStats.is_error = true;
    llmStats.terminal_reason = 'parse_failed';
    if (mode === 'analysis') {
      finalResult = {
        error: 'Failed to extract valid JSON verdict from LLM output',
        classification: 'unknown',
        confidence: 'none',
        casualSummary: 'Automated analysis failed to generate a conclusive verdict.',
        rootCause: 'LLM analysis failed to return structured schema: output was empty or invalid.',
        trigger: 'Analysis execution failure',
        failingAssertion: '',
        suggestedFix: 'Inspect raw LLM output or retry trace analysis.',
        existingFix: null,
        ruledOut: '',
        breakingChange: null,
        suspectedPR: null,
        relatedLinks: [],
        affectedComponent: 'Unknown',
        chosenScreenshotFile: null,
        trendAnalysis: '',
        llmStats
      };
    } else {
      finalResult = {
        answer: 'Failed to generate answer from model response.',
        confidence: 'none',
        relatedLinks: [],
        llmStats
      };
    }
  }

  if (outputFile) {
    fs.writeFileSync(outputFile, JSON.stringify(finalResult, null, 2), 'utf8');
  }

  return finalResult;
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

  const res = parseLlmResponse(options);
  console.log(`Parsed ${options.mode || 'analysis'} response: classification=${res.classification || 'n/a'} confidence=${res.confidence || 'n/a'}`);
}

module.exports = {
  parseLlmResponse,
  extractJsonSubstring,
  salvagePartialJson
};

