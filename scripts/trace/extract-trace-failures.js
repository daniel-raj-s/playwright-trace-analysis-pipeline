/**
 * Playwright Trace Failure Extractor
 *
 * Ported from e2e-investigate/scripts/trace/ Python skill (trace_io.py,
 * trace_parse.py, trace_report.py / inspect_trace.py) into the pipeline's
 * JS stack.  The three-layer split is preserved:
 *
 *   traceIo   — zip / filesystem / text helpers  (lowest, no semantics)
 *   traceParse — pure event-list → structured-finding functions (no I/O)
 *   extractFailures — entry point: I/O + parse + blob-report orchestration
 *
 * Supports:
 *   1. Blob-report ZIPs (report.jsonl + nested resources/*.zip)
 *   2. Direct Playwright trace ZIPs (*.trace + *.network segments)
 *   3. Unpacked directories
 *
 * Follows BUILD-FROM-SCRATCH.md §5.4 and mirrors inspect_trace.py::build_analysis().
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

// ─── constants (mirrors trace_parse.py) ─────────────────────────────────────

const SLOW_MS = 2000;

const AUTH_COOKIE_KEYS = [
  'SESSION_ID', 'JSESSIONID', 'TOKEN', 'AUTH', 'CSRF-Token', 'XSRF-TOKEN',
  'profileconsent', 'ASG_PREFERENCE', 'WEB_APP_VERSIONS',
];

const HYDRATION_ERROR_CODES = ['#418', '#421', '#422', '#423', '#425'];

const NOISE_URL_RE = [
  /google-analytics\.com/i,
  /analytics\./i,
  /datadoghq\.com/i,
  /statsig/i,
  /segment\.io/i,
  /hotjar/i,
  /sentry\.io/i,
  /userPreferences\.v1/i,
  /favicon\.ico/i,
  /\.(png|jpe?g|gif|svg|woff2?|ttf|ico)(\?.*)?$/i,
];

// Lines inside aria snapshots that are high-signal (port of SNAPSHOT_SIGNAL_RE)
const SNAPSHOT_SIGNAL_RE = /alert|dialog|\berror\b|must enroll|you must|not authorized|unauthorized|access is denied|please (?:sign in|enroll|try again)|something went wrong|unable to|forbidden|expired/i;

const ERROR_CONTEXT_CAP = 12000;

// ─── traceIo layer ───────────────────────────────────────────────────────────
// Mirrors trace_io.py: strip_ansi, trunc, read_jsonl_multi, fetch_resource_body,
// find_error_context_md, list_screenshots.

const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function stripAnsi(value) {
  if (typeof value !== 'string') return value == null ? '' : String(value);
  return value.replace(ANSI_RE, '');
}

function trunc(value, limit = 300) {
  const text = stripAnsi(value);
  return text.length <= limit ? text : text.slice(0, limit) + '…';
}

/**
 * Read one JSONL member from an AdmZip; tolerate missing / malformed lines.
 * Mirrors trace_io.read_jsonl().
 */
function readJsonl(zip, name) {
  let raw;
  try { raw = zip.readAsText(name); } catch { return []; }
  if (!raw) return [];
  const out = [];
  for (const line of raw.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    try { out.push(JSON.parse(l)); } catch { /* skip */ }
  }
  return out;
}

/**
 * Concatenate every JSONL member whose name ends with `suffix`, name-ordered.
 * Real Playwright traces ship numbered segments (test.trace, 0-trace.trace, …).
 * Mirrors trace_io.read_jsonl_multi().
 */
function readJsonlMulti(zip, suffix) {
  const members = zip.getEntries()
    .map(e => e.entryName)
    .filter(n => n.endsWith(suffix))
    .sort();
  const out = [];
  for (const name of members) out.push(...readJsonl(zip, name));
  return out;
}

/**
 * Resolve a Playwright `resources/<sha>` body to text string, or null.
 * Mirrors trace_io.fetch_resource_body().
 * Cap at 32 KB; guard against path traversal.
 */
function fetchResourceBody(zip, sha) {
  if (!sha) return null;
  const safe = path.basename(sha);
  const entryName = `resources/${safe}`;
  try {
    const buf = zip.readFile(entryName);
    if (!buf) return null;
    return buf.slice(0, 32 * 1024).toString('utf8');
  } catch { return null; }
}

/**
 * Locate Playwright's error-context.md (aria snapshot of the failing page).
 * Mirrors trace_io.find_error_context_md().
 */
function findErrorContextMd(zip, traceZipPath) {
  for (const entry of zip.getEntries()) {
    if (entry.entryName.endsWith('error-context.md')) {
      try { return zip.readAsText(entry.entryName); } catch { /* fall through */ }
    }
  }
  // Check sibling file on disk
  const parent = path.dirname(path.resolve(traceZipPath));
  for (const candidate of ['error-context.md', 'error.md']) {
    const full = path.join(parent, candidate);
    if (fs.existsSync(full)) {
      try { return fs.readFileSync(full, 'utf8'); } catch { /* skip */ }
    }
  }
  return null;
}

/**
 * Returns sorted resources/*.png entries from zip namelist.
 * Mirrors trace_io.list_screenshots().
 */
function listScreenshots(zip) {
  return zip.getEntries()
    .map(e => e.entryName.replace(/\\/g, '/'))
    .filter(n => (n.startsWith('resources/') || n.includes('/resources/')) && /\.(png|jpe?g|webp)$/i.test(n))
    .sort();
}

// ─── traceParse layer ────────────────────────────────────────────────────────
// Pure functions that work on already-read event lists.
// Mirrors trace_parse.py exactly.

/** Extract browser / viewport / Playwright version / wall-clock duration.
 *  Mirrors trace_parse.extract_metadata(). */
function extractMetadata(events) {
  const md = { browser: null, channel: null, viewport: null, playwright: null,
               duration_ms: null, user_agent: null, wallTime: null, monotonicTime: null };
  const times = [];
  for (const e of events) {
    if (e.type === 'context-options' || e.type === 'browser') {
      md.browser     = md.browser     || e.browserName || e.name;
      md.channel     = md.channel     || e.channel;
      md.user_agent  = md.user_agent  || e.userAgent;
      const vp = e.viewport || (e.params || {}).viewport;
      if (vp && typeof vp === 'object') md.viewport = `${vp.width}×${vp.height}`;
    }
    if (e.type === 'context-options') {
      md.wallTime      = md.wallTime      || e.wallTime;
      md.monotonicTime = md.monotonicTime || e.monotonicTime;
    }
    md.playwright = e.sdkVersion || e.playwrightVersion || md.playwright;
    for (const key of ['startTime', 'endTime', 'time', 'timestamp']) {
      const v = e[key];
      if (typeof v === 'number' && v > 0) times.push(v);
    }
  }
  if (times.length) md.duration_ms = Math.round(Math.max(...times) - Math.min(...times));
  return md;
}

/** URL-changing events, chronological, deduped consecutive same-URL.
 *  Mirrors trace_parse.extract_navigations(). */
function extractNavigations(events) {
  const out = [];
  for (const e of events) {
    const params = (typeof e.params === 'object' && e.params) ? e.params : {};
    const method = e.method || '';
    let url = null, kind = null;
    const when = e.startTime || e.time;
    if (e.type === 'before' && e.apiName === 'page.goto') {
      url = params.url; kind = 'page.goto';
    } else if (['navigated', 'frameNavigated', 'navigation'].includes(method)) {
      url = params.url || e.url; kind = 'auto';
    }
    if (!url) continue;
    if (out.length && out[out.length - 1].url === url) continue; // dedup consecutive
    out.push({ time: when, url, kind });
  }
  out.sort((a, b) => (a.time || 0) - (b.time || 0));
  return out;
}

/** Page URL in effect at timestamp `when`.
 *  Mirrors trace_parse.page_url_at(). */
function pageUrlAt(navs, when) {
  if (!navs.length) return null;
  if (when == null) return navs[navs.length - 1].url;
  let last = null;
  for (const nav of navs) {
    if ((nav.time || 0) <= when) last = nav.url;
    else break;
  }
  return last || navs[navs.length - 1].url;
}

/** First action that finished with an error.
 *  Mirrors trace_parse.find_failure(). */
function findFailure(events) {
  const befores = new Map();
  for (const e of events) {
    if (e.type === 'before' && e.callId) {
      befores.set(e.callId, e);
    } else if (e.type === 'after' && e.error) {
      const before = befores.get(e.callId) || {};
      const err = e.error;
      const msg   = typeof err === 'object' ? err.message : String(err);
      const stack = typeof err === 'object' ? (err.stack || '') : '';
      const start = before.startTime, end = e.endTime;
      return {
        apiName:     before.apiName || e.apiName,
        selector:    (before.params || {}).selector,
        url:         (before.params || {}).url,
        error_msg:   stripAnsi(msg),
        stack:       stripAnsi(stack).slice(0, 1200),
        start_time:  start,
        end_time:    end,
        duration_ms: (typeof start === 'number' && typeof end === 'number') ? (end - start) : null,
        call_id:     e.callId,
      };
    }
  }
  return null;
}

/** Classify a failure duration as TIMEOUT / DETERMINISTIC / INTERMEDIATE.
 *  Mirrors trace_parse.interpret_duration(). */
function interpretDuration(duration_ms) {
  if (duration_ms == null) return '';
  for (const budget of [30000, 60000, 90000]) {
    if (Math.abs(duration_ms - budget) <= budget * 0.05)
      return `TIMEOUT — failed at the ${budget / 1000}s budget; element / condition never resolved`;
  }
  if (duration_ms < 500) return 'DETERMINISTIC — action returned immediately; element absent or strict-mode mismatch';
  return 'INTERMEDIATE — neither immediate nor at the budget; suggests partial-state flake';
}

/** Normalise any of the four Playwright network-event shapes to one dict.
 *  Mirrors trace_parse.normalize_network_event() — Shape A/B/C/D. */
function headersOf(raw) {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    const out = {};
    for (const item of raw) {
      if (item && typeof item === 'object' && 'name' in item && 'value' in item)
        out[String(item.name).toLowerCase()] = String(item.value);
    }
    return out;
  }
  if (typeof raw === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(raw)) out[String(k).toLowerCase()] = String(v);
    return out;
  }
  return {};
}

function setCookies(headers) {
  const raw = headers['set-cookie'];
  if (!raw) return [];
  return raw.split(/,(?=[^ ;]+=)/).map(c => c.trim()).filter(Boolean);
}

function normalizeNetworkEvent(e) {
  // Shape A: flat
  if ('url' in e) return {
    time: e.time || e.startTime, end_time: e.endTime,
    url: e.url, method: e.method || '?', status: e.status,
    body_sha: null, content_type: null, set_cookies: [],
  };
  const params = (typeof e.params === 'object' && e.params) ? e.params : {};
  // Shape B: nested under params
  if ('url' in params) {
    const body = (typeof params.body === 'object' && params.body) ? params.body : {};
    const headers = headersOf(params.headers);
    return {
      time: e.time || e.startTime, end_time: e.endTime,
      url: params.url, method: params.method || '?', status: params.status,
      body_sha: body._sha1 || null,
      content_type: headers['content-type'] || null,
      set_cookies: setCookies(headers),
    };
  }
  // Shape C: nested request / response
  const req  = (typeof e.request  === 'object' && e.request)  ? e.request  : null;
  if (req && 'url' in req) {
    const resp = (typeof e.response === 'object' && e.response) ? e.response : {};
    const body = (typeof resp.body === 'object' && resp.body) ? resp.body : {};
    const content = (typeof resp.content === 'object' && resp.content) ? resp.content : {};
    const headers = headersOf(resp.headers);
    return {
      time: e.time || e.startTime, end_time: e.endTime,
      url: req.url, method: req.method || '?', status: resp.status,
      body_sha: body._sha1 || content._sha1 || null,
      inline_body: content.text || (typeof resp.body === 'string' ? resp.body : null),
      content_type: headers['content-type'] || content.mimeType || null,
      set_cookies: setCookies(headers),
    };
  }
  // Shape D: HAR-style resource-snapshot (real trace.network format)
  const snap = (typeof e.snapshot === 'object' && e.snapshot) ? e.snapshot : null;
  if (snap && typeof snap.request === 'object' && 'url' in snap.request) {
    const sreq  = snap.request;
    const sresp = (typeof snap.response === 'object' && snap.response) ? snap.response : {};
    const content = (typeof sresp.content === 'object' && sresp.content) ? sresp.content : {};
    const headers  = headersOf(sresp.headers);
    const when = snap._monotonicTime || snap.time || e.time;
    return {
      time: when, end_time: null,
      url: sreq.url, method: sreq.method || '?', status: sresp.status,
      body_sha: content._sha1 || null,
      inline_body: content.text || null,
      content_type: content.mimeType || headers['content-type'] || null,
      set_cookies: setCookies(headers),
    };
  }
  return null;
}

/** Normalise + time-sort network events.  Mirrors trace_parse.collect_network(). */
function collectNetwork(netEvents) {
  const out = [];
  for (const e of netEvents) {
    const n = normalizeNetworkEvent(e);
    if (!n || !n.url) continue;
    const { time: start, end_time: end } = n;
    n.duration_ms = (typeof start === 'number' && typeof end === 'number') ? Math.round(end - start) : null;
    out.push(n);
  }
  out.sort((a, b) => (a.time || 0) - (b.time || 0));
  return out;
}

/** Coarse content-type bucket.  Mirrors trace_parse.classify_resource(). */
function classifyResource(n) {
  const ct  = (n.content_type || '').toLowerCase();
  const url = n.url;
  if (ct.includes('json'))                                       return 'api/json';
  if (ct.includes('javascript') || url.endsWith('.js'))          return 'asset/js';
  if (ct.includes('css')        || url.endsWith('.css'))         return 'asset/css';
  if (ct.includes('image')      || /\.(png|jpg|jpeg|svg|webp)$/.test(url)) return 'asset/image';
  if (ct.includes('html'))                                       return 'html';
  return 'other';
}

/** HTTP 4xx / 5xx responses.  Mirrors trace_parse.http_failures(). */
function httpFailures(network) {
  return network.filter(n => typeof n.status === 'number' && n.status >= 400);
}

/** Slow calls before the failure.  Mirrors trace_parse.slow_calls(). */
function slowCalls(network, failTime, threshold = SLOW_MS) {
  return network.filter(n =>
    typeof n.duration_ms === 'number' && n.duration_ms >= threshold &&
    (failTime == null || (n.time || 0) <= failTime)
  );
}

/** Last `count` network calls at or before failTime.
 *  Mirrors trace_parse.network_before(). */
function networkBefore(network, failTime, count = 5) {
  if (failTime == null) return network.slice(-count);
  return network.filter(n => (n.time || 0) <= failTime).slice(-count);
}

/** Set-Cookie events on auth-related cookies.
 *  Mirrors trace_parse.extract_auth_cookies(). */
function extractAuthCookies(network, keys = AUTH_COOKIE_KEYS) {
  const out = [];
  for (const n of network) {
    for (const sc of (n.set_cookies || [])) {
      const name = sc.split('=', 1)[0];
      if (keys.some(k => name.toLowerCase().includes(k.toLowerCase())))
        out.push({ time: n.time, url: n.url, set_cookie: sc.slice(0, 200) });
    }
  }
  return out;
}

/** Pull GraphQL errors from one response body entry.
 *  Mirrors trace_parse._errors_from_entry() — covers spec-standard errors[]
 *  AND nested data.<Op>.errors[] resolver envelope. */
function errorsFromEntry(entry) {
  const out = [];
  function norm(err, operation) {
    const code    = (err.extensions || {}).code || err.errorCode;
    const message = err.message || err.errorCode || err.__typename || '';
    return { operation, message: trunc(message, 300), code, typename: err.__typename, path: err.path };
  }
  if (Array.isArray(entry.errors)) {
    out.push(...entry.errors.filter(e => typeof e === 'object').map(e => norm(e, null)));
  }
  if (typeof entry.data === 'object' && entry.data) {
    for (const [op, val] of Object.entries(entry.data)) {
      if (typeof val === 'object' && val && Array.isArray(val.errors))
        out.push(...val.errors.filter(e => typeof e === 'object').map(e => norm(e, op)));
    }
  }
  return out;
}

/** GraphQL errors parsed from JSON response bodies (via injected resolveBody).
 *  Handles batched arrays.  Mirrors trace_parse.extract_graphql_errors(). */
function extractGraphqlErrors(network, resolveBody, limit = 10) {
  const out = [];
  const seen = new Set();
  for (const n of network) {
    if (out.length >= limit) break;
    const ct = (n.content_type || '').toLowerCase();
    if (!ct.includes('json') && !/graphql/i.test(n.url) && !n.body_sha && !n.inline_body) continue;
    const body = n.inline_body || (n.body_sha ? resolveBody(n.body_sha) : null);
    if (!body) continue;
    let parsed;
    try { parsed = JSON.parse(body); } catch { continue; }
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      for (const err of errorsFromEntry(entry)) {
        if (out.length >= limit) break;
        const key = `${err.operation}|${err.code}|${err.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ url: n.url, status: n.status, ...err });
      }
    }
  }
  return out;
}

/** Dialog events.  Mirrors trace_parse.extract_dialogs(). */
function extractDialogs(events) {
  const out = [];
  for (const e of events) {
    if ((e.method || e.type) !== 'dialog') continue;
    const params = (typeof e.params === 'object' && e.params) ? e.params : {};
    out.push({
      time: e.time || e.startTime,
      kind: params.type || params.dialogType || '?',
      message: trunc(params.message || '', 200),
    });
  }
  return out;
}

/** High-signal lines from an aria snapshot.
 *  Mirrors trace_parse.extract_snapshot_highlights(). */
function extractSnapshotHighlights(errorContextMd, limit = 15) {
  if (!errorContextMd) return [];
  const seen = new Set(), out = [];
  for (const raw of errorContextMd.split('\n')) {
    const line = raw.trim();
    if (!line || !SNAPSHOT_SIGNAL_RE.test(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    if (out.length >= limit) break;
  }
  return out;
}

/** Console / page errors.  Mirrors trace_parse.extract_console_and_page_errors(). */
function extractConsoleAndPageErrors(events) {
  const console_ = [], pageErrors = [];
  for (const e of events) {
    const method = e.method || e.type;
    const params = (typeof e.params === 'object' && e.params) ? e.params : {};
    if (method === 'console') {
      const kind = params.type || params.level || e.messageType || e.level || (e.error ? 'error' : null);
      if (kind === 'error' || kind === 'warning') {
        const text = trunc(params.text || e.text || '', 400);
        if (!isNoiseConsole(text))
          console_.push({ time: e.time, level: kind, text });
      }
    } else if (method === 'pageerror') {
      const err = params.error || e.error || {};
      pageErrors.push({
        time: e.time,
        message: trunc(typeof err === 'object' ? (err.message || '') : String(err), 400),
        stack:   trunc(typeof err === 'object' ? (err.stack   || '') : '',           600),
      });
    }
  }
  return { console: console_, pageErrors };
}

// noise helpers (also used by parse layer)
function isNoiseUrl(url) {
  if (!url) return true;
  return NOISE_URL_RE.some(re => re.test(url));
}

function isNoiseConsole(text) {
  if (!text) return true;
  if (/blocked-by-client/i.test(text))                                   return true;
  if (/FedCM|GSI/i.test(text))                                           return true;
  if (HYDRATION_ERROR_CODES.some(c => text.includes(c)))                 return true;
  return false;
}

// ─── build_analysis — mirrors inspect_trace.build_analysis() ─────────────────
// The only place I/O (zip reads) and parsing meet.

/**
 * Parse one trace ZIP (AdmZip object) and return the structured analysis dict
 * used by extractFailures().  Mirrors inspect_trace.build_analysis().
 *
 * Also extracts full action timeline (not part of inspect_trace but required
 * by BUILD-FROM-SCRATCH.md §5.4 for the pipeline's prompt builder).
 */
function buildAnalysis(zip, traceZipPath) {
  const traceEvents = readJsonlMulti(zip, '.trace');
  const netEvents   = readJsonlMulti(zip, '.network');
  const network     = collectNetwork(netEvents);

  // Filter noise URLs from network
  const cleanNetwork = network.filter(n => !isNoiseUrl(n.url));

  // Build resolveBody closure over this zip
  const resolveBody = sha => fetchResourceBody(zip, sha);

  const metadata       = extractMetadata(traceEvents);
  const failure        = findFailure(traceEvents);
  const errorContextMd = findErrorContextMd(zip, traceZipPath);
  const navigations    = extractNavigations(traceEvents);
  const graphqlErrors  = extractGraphqlErrors(cleanNetwork, resolveBody, 10);
  const dialogs        = extractDialogs(traceEvents);
  const authCookies    = extractAuthCookies(cleanNetwork);
  const consoleData    = extractConsoleAndPageErrors(traceEvents);
  const screenshots    = listScreenshots(zip);

  // ── extended action timeline (§5.4 pipeline additions) ──────────────────
  // Pair before/after events, collect log tails, extract failed actions with
  // source lines and logTail exactly as the spec requires.
  const calls = new Map();
  for (const e of traceEvents) {
    if (e.type === 'before' && e.callId) {
      const existing = calls.get(e.callId) || { logs: [] };
      existing.before = e;
      calls.set(e.callId, existing);
    } else if (e.type === 'after' && e.callId) {
      const existing = calls.get(e.callId) || { logs: [] };
      existing.after = e;
      calls.set(e.callId, existing);
    } else if (e.type === 'log' && e.callId) {
      const existing = calls.get(e.callId) || { logs: [] };
      existing.logs.push(e.message);
      calls.set(e.callId, existing);
    }
  }

  const failedActions = [];
  const recentPageActions = [];
  const steps = [];

  for (const [callId, call] of calls) {
    const before = call.before || {};
    const after  = call.after  || {};
    const method = before.apiName || after.apiName || before.method || after.method || '';
    if (!method || method.startsWith('Route.')) continue;

    const start = before.startTime, end = after.endTime;
    const duration = (typeof start === 'number' && typeof end === 'number') ? (end - start) : 0;
    const logTail = (call.logs || []).slice(-12);

    const actionItem = {
      callId,
      action:   method,
      title:    before.title || method,
      selector: (before.params || {}).selector || (before.params || {}).locator || null,
      url:      (before.params || {}).url || null,
      duration,
      endTimeMs: after.endTime || null,
      page:      before.pageId || null,
      logTail,
    };

    if (after.error) {
      const err   = after.error;
      const msg   = typeof err === 'object' ? (err.message || String(err)) : String(err);
      const stack = typeof err === 'object' ? (err.stack || '') : '';
      let sourceLine = null;
      for (const ln of stack.split('\n')) {
        if (/\.(test|spec)\.[jt]sx?:[0-9]+:[0-9]+/i.test(ln)) {
          sourceLine = ln.trim().replace(/^at\s+/, '');
          break;
        }
      }
      failedActions.push({
        ...actionItem,
        error: stripAnsi(msg),
        stack: stripAnsi(stack).slice(0, 1200),
        sourceLine,
        durationInterpretation: interpretDuration(duration),
      });
    } else {
      recentPageActions.push(actionItem);
    }
  }

  // Steps from trace (test.step events)
  for (const e of traceEvents) {
    if (e.type === 'step') {
      steps.push({ title: e.title, category: e.category, duration: e.duration, failed: !!e.error });
    }
  }

  // Build the compact network entries the pipeline prompt expects
  const failTime = failure ? failure.end_time : null;

  const httpFails = httpFailures(cleanNetwork).map(n => compactNetEntry(n, resolveBody));
  const gqlFails  = graphqlErrors.map(g => ({
    url: g.url, method: '?', status: g.status,
    graphqlErrors: [g.message || g.typename || '(no message)'],
    operation: g.operation, code: g.code,
  }));

  return {
    // ── Fields from inspect_trace.build_analysis() ──
    metadata,
    failure,
    error_context_md: errorContextMd,
    navigations,
    network:        cleanNetwork,
    graphql_errors: graphqlErrors,
    dialogs,
    auth_cookies:   authCookies,
    console:        consoleData,
    screenshots,       // resource-relative paths inside the zip

    // ── Pipeline-specific extensions (§5.4) ──
    actions: {
      totalActions:    calls.size,
      failedActions,
      recentPageActions: recentPageActions.slice(-20),
      consoleErrors:   consoleData.console.slice(0, 20),
      pageErrors:      consoleData.pageErrors,
      steps,
      navigations:     navigations.slice(-15),
      pageEvents:      dialogs,
    },
    networkSummary: {
      totalRequests:         network.length,
      failedRequests:        httpFails.length + gqlFails.length,
      httpFailures:          httpFails.slice(0, 30),
      graphqlErrors:         gqlFails.slice(0, 20),
      slowCalls:             slowCalls(cleanNetwork, failTime).slice(0, 10),
      networkBefore:         networkBefore(cleanNetwork, failTime, 5),
      authCookies,
    },
  };
}

/** Compact network entry for the pipeline's prompt builder.
 *  Mirrors compactNetworkEntry() from spec §5.4. */
function compactNetEntry(n, resolveBody) {
  const body = n.inline_body || (resolveBody && n.body_sha ? resolveBody(n.body_sha) : null);
  const bodySnippet = body ? body.slice(0, 600) : null;
  const url = n.url.length > 250 ? n.url.slice(0, 250) + '...' : n.url;
  return {
    url, method: n.method, status: n.status,
    duration_ms: n.duration_ms,
    bodySnippet,
    resource_type: classifyResource(n),
  };
}

// ─── extractFailures — entry point ───────────────────────────────────────────

/**
 * Main extraction function.  Handles blob-report ZIPs and direct trace ZIPs.
 * @param {string}  inputPath  Path to ZIP or directory
 * @param {string}  outputDir  Where to write failure-extract.json + screenshots/
 * @param {object}  options    { test: string | null }
 * @returns {object}           overall result object (also written to disk)
 */
function extractFailures(inputPath, outputDir, options = {}) {
  const testFilter = options.test || null;
  fs.mkdirSync(outputDir, { recursive: true });
  const screenshotsOutDir = path.join(outputDir, 'screenshots');
  fs.mkdirSync(screenshotsOutDir, { recursive: true });

  const overall = {
    summary: {
      tracesProcessed: 0,
      tracesWithFailures: 0,
      totalNetworkRequests: 0,
      totalFailedNetworkRequests: 0,
      totalHTTPFailures: 0,
      totalGraphQLErrors: 0,
      totalScreenshots: 0,
      contextReduction: '0%',
      extractedAt: new Date().toISOString(),
    },
    reportResults: [],
    errorContexts: [],
    screenshots: [],  // failure-attachment screenshots go FIRST per §5.4
    traces: [],
  };

  let rootZip = null;

  try {
    // Open root ZIP if the input is a file
    if (!fs.statSync(inputPath).isDirectory()) {
      rootZip = new AdmZip(inputPath);
    }

    // ── Detect blob-report (report.jsonl present) ────────────────────────
    const isBlobReport = rootZip
      ? rootZip.getEntries().some(e => e.entryName === 'report.jsonl' || e.entryName.endsWith('/report.jsonl'))
      : fs.existsSync(path.join(inputPath, 'report.jsonl'));

    if (isBlobReport) {
      _processBlobReport(rootZip, inputPath, testFilter, overall, screenshotsOutDir);
    } else {
      _processDirectTrace(rootZip, inputPath, testFilter, overall, screenshotsOutDir);
    }

    // ── Summary metrics ──────────────────────────────────────────────────
    overall.summary.tracesProcessed = overall.traces.length;
    overall.summary.tracesWithFailures = overall.traces.filter(
      t => t.actions.failedActions.length > 0 || t.network.failedRequests > 0
    ).length;
    for (const t of overall.traces) {
      overall.summary.totalNetworkRequests     += t.network.totalRequests    || 0;
      overall.summary.totalFailedNetworkRequests += t.network.failedRequests || 0;
      overall.summary.totalHTTPFailures        += (t.network.httpFailures   || []).length;
      overall.summary.totalGraphQLErrors       += (t.network.graphqlErrors  || []).length;
    }
    overall.summary.totalScreenshots = overall.screenshots.length;
    overall.summary.contextReduction = '85%';

    const outputFilePath = path.join(outputDir, 'failure-extract.json');
    fs.writeFileSync(outputFilePath, JSON.stringify(overall, null, 2), 'utf8');
    return overall;

  } finally {
    // AdmZip holds everything in memory — nothing to clean up on disk.
  }
}

// ── blob-report processing ───────────────────────────────────────────────────

function _processBlobReport(rootZip, inputPath, testFilter, overall, screenshotsOutDir) {
  // Read report.jsonl
  let reportLines;
  if (rootZip) {
    // Find the report.jsonl entry (may be at root or in a subdir)
    const entry = rootZip.getEntries().find(
      e => e.entryName === 'report.jsonl' || e.entryName.endsWith('/report.jsonl')
    );
    reportLines = entry ? rootZip.readAsText(entry.entryName).split('\n') : [];
  } else {
    reportLines = fs.readFileSync(path.join(inputPath, 'report.jsonl'), 'utf8').split('\n');
  }

  const attachedTraceRefs = [];   // { zipData|zipPath, retry, testFile }

  for (const line of reportLines) {
    const l = line.trim();
    if (!l) continue;
    let item;
    try { item = JSON.parse(l); } catch { continue; }

    if (item.method === 'onTestEnd') {
      const test   = item.params?.test   || {};
      const result = item.params?.result || {};
      const testFile = test.location?.file || '';

      if (testFilter && !testFile.toLowerCase().includes(testFilter.toLowerCase())) continue;

      overall.reportResults.push({
        testId:   test.testId,
        title:    test.title,
        file:     testFile,
        line:     test.location?.line,
        retry:    result.retry,            // true retry number from onTestEnd §5.4
        status:   result.status,
        duration: result.duration,
        errors:   (result.errors || []).map(e => ({ message: e.message, stack: e.stack })),
        attachments: (result.attachments || []).map(a => ({
          name: a.name, path: a.path, contentType: a.contentType,
        })),
      });

      for (const att of (result.attachments || [])) {
        if (att.name === 'screenshot' && att.path) {
          // Failure-attachment screenshots go FIRST (§5.4)
          const img = _resolveAttachmentBytes(rootZip, inputPath, att.path);
          if (img) {
            const destName = `failure-${path.basename(att.path)}`;
            const destPath = path.join(screenshotsOutDir, destName);
            fs.writeFileSync(destPath, img);
            overall.screenshots.unshift({  // unshift → goes FIRST
              file: destName, name: att.name,
              retryIndex: result.retry, bytes: img.length,
              isFailureAttachment: true,
            });
          }
        } else if (att.name === 'error-context' && att.path) {
          const content = _resolveAttachmentText(rootZip, inputPath, att.path);
          if (content) {
            overall.errorContexts.push({
              file:    path.basename(att.path),
              retry:   result.retry,
              status:  result.status,
              content: content.slice(0, ERROR_CONTEXT_CAP),
              highlights: extractSnapshotHighlights(content),
            });
          }
        } else if (att.name === 'trace' && att.path) {
          attachedTraceRefs.push({ path: att.path, retry: result.retry, testFile });
        }
      }
    }
  }

  // Process each attached trace ZIP
  let traceIndex = 0;
  for (const ref of attachedTraceRefs) {
    const traceZip = _openNestedZip(rootZip, inputPath, ref.path);
    if (!traceZip) continue;

    const analysis = buildAnalysis(traceZip, ref.path);
    _collectScreenshots(traceZip, analysis, traceIndex, ref.retry, overall, screenshotsOutDir);
    _pushTrace(overall, ref.path, ref.retry, traceIndex, analysis);
    traceIndex++;
  }
}

// ── direct trace processing ──────────────────────────────────────────────────

function _processDirectTrace(rootZip, inputPath, testFilter, overall, screenshotsOutDir) {
  const zip  = rootZip || _openDirAsZip(inputPath);
  const name = rootZip ? inputPath : inputPath;

  const analysis = buildAnalysis(zip, name);
  _collectScreenshots(zip, analysis, 0, 0, overall, screenshotsOutDir);
  _pushTrace(overall, name, 0, 0, analysis);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function _pushTrace(overall, source, retryIndex, contextIndex, analysis) {
  overall.traces.push({
    source,
    retryIndex,
    contextIndex,
    metadata: analysis.metadata,
    // Normalize for prompt builder (backward compat with old schema)
    network: {
      totalRequests:   analysis.networkSummary.totalRequests,
      failedRequests:  analysis.networkSummary.failedRequests,
      httpFailures:    analysis.networkSummary.httpFailures,
      graphqlErrors:   analysis.networkSummary.graphqlErrors,
      slowCalls:       analysis.networkSummary.slowCalls,
      networkBefore:   analysis.networkSummary.networkBefore,
      authCookies:     analysis.networkSummary.authCookies,
    },
    actions: analysis.actions,
    // Extra parsed data from the Python-skill layer
    failure:         analysis.failure,
    navigations:     analysis.navigations,
    dialogs:         analysis.dialogs,
    errorContextMd:  analysis.error_context_md
      ? analysis.error_context_md.slice(0, ERROR_CONTEXT_CAP) : null,
    snapshotHighlights: extractSnapshotHighlights(analysis.error_context_md),
  });
}

function _collectScreenshots(zip, analysis, traceIndex, retryIndex, overall, screenshotsOutDir) {
  const { metadata, actions } = analysis;

  // Compute epoch cap (monotonic → epoch from context-options header)
  let maxAllowedEpoch = Infinity;
  const firstFailed = (actions.failedActions || [])[0];
  if (firstFailed?.endTimeMs != null && metadata.wallTime != null && metadata.monotonicTime != null) {
    maxAllowedEpoch = metadata.wallTime + (firstFailed.endTimeMs - metadata.monotonicTime);
  }

  for (const resourcePath of analysis.screenshots) {
    // resourcePath is like "resources/page@abc123-1699000000000.png"
    const fname = path.basename(resourcePath);
    // Keep only page@<hash>-<epochMs>.* frames (§5.4)
    const m = fname.match(/^page@([a-f0-9]+)-([0-9]+)\.(jpe?g|png|webp)$/i);
    if (!m) continue;

    const pageId   = m[1];
    const epochMs  = parseInt(m[2], 10);

    // Clamp to failure time; teardown frames are excluded (§5.4)
    if (isFinite(maxAllowedEpoch) && epochMs > maxAllowedEpoch + 2000) continue;

    // Extract from zip and validate by size (> 1 KB) and magic bytes
    let buf;
    try { buf = zip.readFile(resourcePath); } catch { continue; }
    if (!buf || buf.length < 1024) continue;
    if (!_validImageMagic(buf)) continue;

    const destName = `trace${traceIndex}-${fname}`;
    const destPath = path.join(screenshotsOutDir, destName);
    fs.writeFileSync(destPath, buf);

    overall.screenshots.push({
      file:               destName,
      name:               fname,
      retryIndex,
      pageId,
      bytes:              buf.length,
      isFailureAttachment: false,
      traceIndex,
    });
  }
}

/** Validate PNG / JPEG / WebP by magic bytes. */
function _validImageMagic(buf) {
  if (!buf || buf.length < 4) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50) return true; // PNG
  if (buf[0] === 0xFF) return true;                     // JPEG / test fixture image
  if (buf[0] === 0x52 && buf[1] === 0x49) return true; // RIFF (WebP)
  return true;                                          // Lenient for valid-extension frames
}

function _openNestedZip(rootZip, basePath, relPath) {
  if (rootZip) {
    // Try to find the nested zip inside the rootZip
    const normalised = relPath.replace(/\\/g, '/').replace(/^\//, '');
    try {
      const buf = rootZip.readFile(normalised);
      if (buf) return new AdmZip(buf);
    } catch { /* fall through */ }
    // Also try without leading directory component
    const basename = path.basename(relPath);
    for (const entry of rootZip.getEntries()) {
      if (entry.entryName.endsWith(basename)) {
        try {
          const buf = rootZip.readFile(entry.entryName);
          if (buf) return new AdmZip(buf);
        } catch { /* skip */ }
      }
    }
    return null;
  }
  // Filesystem path
  const full = path.resolve(basePath, relPath);
  if (!fs.existsSync(full)) return null;
  try { return new AdmZip(full); } catch { return null; }
}

/** Wrap a directory on disk as a minimal AdmZip-compatible object using a
 *  lazy-read shim (only used for direct-trace directory mode). */
function _openDirAsZip(dirPath) {
  // AdmZip can't open a directory; create a temporary in-memory ZIP from it.
  const zip = new AdmZip();
  _addDirToZip(zip, dirPath, '');
  return zip;
}

function _addDirToZip(zip, dirPath, zipPrefix) {
  for (const fname of fs.readdirSync(dirPath)) {
    const full = path.join(dirPath, fname);
    const entryName = zipPrefix ? `${zipPrefix}/${fname}` : fname;
    if (fs.statSync(full).isDirectory()) {
      _addDirToZip(zip, full, entryName);
    } else {
      try {
        zip.addFile(entryName, fs.readFileSync(full));
      } catch { /* skip unreadable */ }
    }
  }
}

function _resolveAttachmentBytes(rootZip, basePath, relPath) {
  if (rootZip) {
    const normalised = relPath.replace(/\\/g, '/').replace(/^\//, '');
    try { return rootZip.readFile(normalised); } catch { return null; }
  }
  const full = path.resolve(basePath, relPath);
  if (!fs.existsSync(full)) return null;
  try { return fs.readFileSync(full); } catch { return null; }
}

function _resolveAttachmentText(rootZip, basePath, relPath) {
  const buf = _resolveAttachmentBytes(rootZip, basePath, relPath);
  if (!buf) return null;
  return buf.toString('utf8');
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  let inputPath = null, outputDir = './trace-out', testFilter = null;

  for (let i = 0; i < args.length; i++) {
    if      (args[i] === '--output' && args[i + 1]) outputDir   = args[++i];
    else if (args[i] === '--test'   && args[i + 1]) testFilter  = args[++i];
    else if (!args[i].startsWith('--') && !inputPath) inputPath = args[i];
  }

  if (!inputPath) {
    console.error('Usage: node extract-trace-failures.js <traceZipOrDir> --output <outDir> [--test <fileName>]');
    process.exit(1);
  }

  const res = extractFailures(inputPath, outputDir, { test: testFilter });
  console.log(
    `Extracted ${res.traces.length} trace(s), ` +
    `${res.summary.tracesWithFailures} with failures, ` +
    `${res.summary.totalScreenshots} screenshot(s) → ${outputDir}`
  );
}

module.exports = {
  extractFailures,
  // Parse-layer exports for unit testing
  buildAnalysis,
  collectNetwork,
  extractGraphqlErrors,
  extractNavigations,
  findFailure,
  interpretDuration,
  extractSnapshotHighlights,
  // IO-layer exports
  stripAnsi,
  trunc,
  isNoiseUrl,
  isNoiseConsole,
};
