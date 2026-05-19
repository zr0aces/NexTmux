const DEFAULT_PATTERNS = [
  { name: "continue", regex: "continue\\?" },
  { name: "proceed", regex: "proceed\\?" },
  { name: "confirmation", regex: "\\[y/N\\]" },
  { name: "yes_no", regex: "yes/no" },
  { name: "press_enter", regex: "press enter" },
  { name: "approve", regex: "approve\\?" },
  { name: "confirm", regex: "confirm\\?" },
  { name: "retry", regex: "retry\\?" },
  { name: "token_limit", regex: "token limit reached" },
  { name: "usage_limit", regex: "usage limit(?:\\s+(?:reached|exceeded|hit|has been reached))" },
  { name: "rate_limited", regex: "(?:you(?:'re| are) (?:rate.limited|out of (?:free )?uses)|daily limit(?:\\s+(?:hit|reached|exceeded)))" },
  { name: "rate_limit_options", regex: "(?:/rate-limit-options|rate-limit-options)" },
  { name: "auth_required", regex: "authentication required" },
];

// Regex to extract a human-readable reset time from terminal output.
// Matches patterns like:
//   "try again in 2 hours"  "resets in 3h 15m"  "available again in 45 minutes"
//   "resets at 11:00 AM PST"  "come back in 1 day"
const RESET_TIME_RE = /(?:try(?:\s+again)?(?:\s+in)?|resets?(?:\s+(?:in|at))?|available(?:\s+again)?\s+in|come\s+back\s+in|limit\s+resets?(?:\s+(?:in|at))?)\s+([0-9a-z][^.\n!?]{2,80}?)(?:\s*[.!\n]|$)/i;

function extractResetTime(text) {
  if (!text) return null;
  const m = RESET_TIME_RE.exec(text);
  return m ? m[1].trim().replace(/\s+/g, " ") : null;
}

function toSafePattern(item, idx) {
  if (!item || typeof item.regex !== "string" || !item.regex.trim()) return null;
  const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : `pattern_${idx + 1}`;
  try {
    return { name, regex: new RegExp(item.regex, "i") };
  } catch {
    return null;
  }
}

function createPatternEngine({ patterns = DEFAULT_PATTERNS, linesToInspect = 120 } = {}) {
  const compiled = (Array.isArray(patterns) ? patterns : DEFAULT_PATTERNS)
    .map(toSafePattern)
    .filter(Boolean);
  const inspectCount = Math.max(10, Number(linesToInspect) || 120);

  function detect(output) {
    const text = String(output || "");
    const lines = text.split("\n");
    const excerpt = lines.slice(-inspectCount).join("\n");

    for (const item of compiled) {
      const match = excerpt.match(item.regex);
      if (!match) continue;
      return {
        matched: true,
        patternName: item.name,
        matchedText: match[0] || "",
        excerpt,
        detectedAt: new Date().toISOString(),
      };
    }

    return {
      matched: false,
      patternName: null,
      matchedText: "",
      excerpt,
      detectedAt: null,
    };
  }

  return {
    detect,
    getCompiledCount: () => compiled.length,
  };
}

module.exports = {
  DEFAULT_PATTERNS,
  createPatternEngine,
  extractResetTime,
};
