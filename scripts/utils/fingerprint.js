/**
 * Error Fingerprinting & Similarity Calculation
 * Follows exact specifications from BUILD-FROM-SCRATCH.md (Section 5.2 & 13.12).
 */

const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

/**
 * Generates an exact 200-char normalized error fingerprint.
 * Normalizes newlines and clamps to 500 chars FIRST so snippets match full text.
 * @param {string|Error|null|undefined} err 
 * @returns {string|null} 200-char normalized fingerprint or null if empty
 */
function createErrorFingerprint(err) {
  if (!err) return null;
  const str = String(err);
  if (!str.trim()) return null;

  return str
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 500)
    .replace(ANSI_REGEX, '')
    .replace(/\[[0-9]+m/g, '')
    .replace(/\bhttps?:\/\/[^\s)"']+/gi, '<URL>')
    .replace(/\b[0-9a-f]{8,}\b/g, '<ID>')
    .replace(/(?=[a-zA-Z0-9_-]*\d)[a-zA-Z0-9_-]{12,}/g, '<ID>')
    .replace(/at line \d+/g, 'at line <N>')
    .replace(/:\d+:\d+/g, ':<N>:<N>')
    .replace(/\d+(\.\d+)?\s*(ms|s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours)\b/gi, '<DUR>')
    .replace(/\d+/g, '<N>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * Computes 3-character shingles for similarity.
 * @param {string} str 
 * @returns {Set<string>}
 */
function getShingles(str) {
  const shingles = new Set();
  const normalized = (str || '').toLowerCase();
  for (let i = 0; i <= normalized.length - 3; i++) {
    shingles.add(normalized.slice(i, i + 3));
  }
  return shingles;
}

/**
 * Token 3-shingle Jaccard similarity between fingerprints.
 * Advisory only: >= 0.75 indicates same incident / DOM drift.
 * @param {string} fp1 
 * @param {string} fp2 
 * @returns {number} 0.0 to 1.0
 */
function calculateSimilarity(fp1, fp2) {
  if (!fp1 || !fp2) return 0;
  if (fp1 === fp2) return 1.0;

  const s1 = getShingles(fp1);
  const s2 = getShingles(fp2);

  if (s1.size === 0 || s2.size === 0) return 0;

  let intersection = 0;
  for (const item of s1) {
    if (s2.has(item)) intersection++;
  }

  const union = s1.size + s2.size - intersection;
  return union === 0 ? 0 : Number((intersection / union).toFixed(4));
}

module.exports = {
  createErrorFingerprint,
  calculateSimilarity
};

