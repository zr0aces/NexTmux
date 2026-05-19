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

const TIMEZONE_OFFSETS_MIN = {
  UTC: 0, GMT: 0,
  EST: -300, EDT: -240,
  CST: -360, CDT: -300,
  MST: -420, MDT: -360,
  PST: -480, PDT: -420,
};

function parseResetEpoch(text, now = Date.now()) {
  if (!text || typeof text !== "string") return null;
  const s = text.trim();

  // Relative: "2 hours", "3h 15m", "45 minutes", "1 day", "90s"
  const unitRe = /(\d+)\s*(d(?:ays?)?|h(?:ours?)?|m(?:in(?:utes?)?)?|s(?:ec(?:onds?)?)?)\b/gi;
  let totalMs = 0;
  let rm;
  while ((rm = unitRe.exec(s)) !== null) {
    const val = parseInt(rm[1], 10);
    const unit = rm[2][0].toLowerCase();
    if (unit === "d") totalMs += val * 86400000;
    else if (unit === "h") totalMs += val * 3600000;
    else if (unit === "m") totalMs += val * 60000;
    else if (unit === "s") totalMs += val * 1000;
  }
  if (totalMs > 0) return now + totalMs;

  // Absolute: "11:00 AM PST", "15:30 UTC", "3:45 PM"
  const absRe = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?(?:\s+(UTC|GMT|EST|EDT|CST|CDT|MST|MDT|PST|PDT|GMT[+-]\d+(?::\d+)?))?/i;
  const absMatch = absRe.exec(s);
  if (absMatch) {
    let h = parseInt(absMatch[1], 10);
    const min = parseInt(absMatch[2], 10);
    const ampm = (absMatch[4] || "").toUpperCase();
    const tzStr = (absMatch[5] || "").toUpperCase();

    if (ampm === "PM" && h !== 12) h += 12;
    if (ampm === "AM" && h === 12) h = 0;
    if (h > 23 || min > 59) return null;

    let tzOffMin = 0;
    if (tzStr in TIMEZONE_OFFSETS_MIN) {
      tzOffMin = TIMEZONE_OFFSETS_MIN[tzStr];
    } else {
      const gmtMatch = /^GMT([+-])(\d+)(?::(\d+))?$/.exec(tzStr);
      if (gmtMatch) {
        tzOffMin = (gmtMatch[1] === "+" ? 1 : -1) *
          (parseInt(gmtMatch[2], 10) * 60 + parseInt(gmtMatch[3] || "0", 10));
      }
    }

    // Convert stated h:m (in tzStr timezone) to UTC:
    // UTC = local_time_treated_as_UTC - tzOffMin (because local = UTC + tzOffMin)
    const d = new Date(now);
    const todayAtHM = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, min, 0, 0);
    const targetMs = todayAtHM - tzOffMin * 60000;
    return targetMs <= now ? targetMs + 86400000 : targetMs;
  }

  return null;
}

module.exports = {
  DEFAULT_PATTERNS,
  createPatternEngine,
  extractResetTime,
  parseResetEpoch,
};
