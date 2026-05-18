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
  { name: "auth_required", regex: "authentication required" },
];

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
};
