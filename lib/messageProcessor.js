const RATE_LIMIT_PATTERN_NAMES = new Set(["token_limit", "usage_limit", "rate_limited", "rate_limit_options"]);

function tailExcerpt(output, linesToInspect = 120) {
  const text = String(output || "");
  const lines = text.split("\n");
  const count = Math.max(10, Number(linesToInspect) || 120);
  return lines.slice(-count).join("\n");
}

function parseSelectableOptions(excerpt) {
  const options = [];
  const lineRe = /^\s*(?:\[\s*([A-Za-z0-9]+)\s*\]|([A-Za-z0-9]+)\s*[.):-])\s*(.+?)\s*$/;
  for (const line of String(excerpt || "").split("\n")) {
    const m = lineRe.exec(line);
    if (!m) continue;
    options.push({
      key: String(m[1] || m[2] || "").trim(),
      text: String(m[3] || "").trim(),
      line: line.trim(),
    });
  }
  return options;
}

function analyzePrompt(excerpt, existingPatternName = null) {
  const text = String(excerpt || "");
  const options = parseSelectableOptions(text);
  const yesOption = options.find((opt) => /^(?:yes|y)\b/i.test(opt.text));
  const rateLimitOption = options.find((opt) => /\bstop\s+and\s+wait\s+for\s+limit\s+to\s+reset\b/i.test(opt.text));

  const hasSelectionCue = /(?:select|choose|pick)\s+(?:an?\s+)?option|enter\s+(?:a\s+)?number|type\s+(?:a\s+)?number|respond\s+with/i.test(text);
  const hasYesNoPrompt = /\[(?:y|yes)\s*\/\s*(?:n|no)\]|\byes\s*\/\s*no\b/i.test(text);
  const hasPressEnterPrompt = /\b(?:press|hit|tap)\s+(?:the\s+)?(?:enter|return)\b/i.test(text);
  const hasConfirmationPrompt = /\b(?:continue|proceed|confirm|approve|retry|allow|permission|overwrite|replace|execute|run)\b[^.\n]{0,120}\?/i.test(text);
  const hasInputRequest = /\b(?:enter|type|input|provide)\b[^.\n]{0,80}\b(?:choice|selection|response|answer)\b/i.test(text);

  const requiresResponse = Boolean(
    hasYesNoPrompt
    || hasPressEnterPrompt
    || hasConfirmationPrompt
    || hasInputRequest
    || rateLimitOption
    || yesOption
    || (options.length > 0 && hasSelectionCue)
  );

  let promptPatternName = existingPatternName || null;
  let matchedLine = null;
  if (rateLimitOption) {
    promptPatternName = "rate_limit_options";
    matchedLine = rateLimitOption.line;
  } else if (hasPressEnterPrompt) {
    promptPatternName = promptPatternName || "press_enter";
    matchedLine = text.split("\n").find((line) => /\b(?:press|hit|tap)\s+(?:the\s+)?(?:enter|return)\b/i.test(line))?.trim() || null;
  } else if (yesOption || (options.length > 0 && hasSelectionCue)) {
    promptPatternName = promptPatternName || "numbered_selection";
    matchedLine = (yesOption || options[0])?.line || null;
  } else if (hasYesNoPrompt) {
    promptPatternName = promptPatternName || "yes_no";
    matchedLine = text.split("\n").find((line) => /\[(?:y|yes)\s*\/\s*(?:n|no)\]|\byes\s*\/\s*no\b/i.test(line))?.trim() || null;
  } else if (hasConfirmationPrompt || hasInputRequest) {
    promptPatternName = promptPatternName || "confirmation";
    matchedLine = text.split("\n").find((line) => /\?|choice|selection|response|answer/i.test(line))?.trim() || null;
  }

  return {
    requiresResponse,
    promptPatternName,
    matchedLine,
    options,
    yesOption,
    rateLimitOption,
    hasPressEnterPrompt,
    hasYesNoPrompt,
    hasConfirmationPrompt,
  };
}

function resolveAutoResponse(detection) {
  const excerpt = String(detection?.excerpt || "");
  const prompt = analyzePrompt(excerpt, detection?.patternName || null);
  if (prompt.rateLimitOption) return prompt.rateLimitOption.key;

  const looksRateLimited = RATE_LIMIT_PATTERN_NAMES.has(detection?.patternName)
    || /(?:\/rate-limit-options|rate\s*limit|usage\s*limit|token\s*limit|you(?:'|’)ve hit your limit)/i.test(excerpt);
  if (looksRateLimited) return null;

  if (prompt.hasPressEnterPrompt || detection?.patternName === "press_enter") return "";
  if (prompt.yesOption) return prompt.yesOption.key;
  if (prompt.hasYesNoPrompt || prompt.hasConfirmationPrompt) return "y";
  return null;
}

function createMessageProcessor({ patternEngine, linesToInspect = 120 } = {}) {
  function detect(output) {
    const base = patternEngine?.detect
      ? patternEngine.detect(output || "")
      : { matched: false, patternName: null, matchedText: "", excerpt: tailExcerpt(output, linesToInspect), detectedAt: null };

    const excerpt = String(base?.excerpt || tailExcerpt(output, linesToInspect));
    const prompt = analyzePrompt(excerpt, base?.patternName || null);
    const matched = Boolean(base?.matched || prompt.requiresResponse);
    const patternName = base?.patternName || prompt.promptPatternName || null;
    const matchedText = base?.matchedText || prompt.matchedLine || "";
    const matchedLine = base?.matchedLine || prompt.matchedLine || matchedText || "";

    return {
      matched,
      patternName,
      matchedText,
      matchedLine,
      excerpt,
      detectedAt: base?.detectedAt || (matched ? new Date().toISOString() : null),
      autoResponse: resolveAutoResponse({ patternName, excerpt }),
    };
  }

  return {
    detect,
    resolveAutoResponse,
  };
}

module.exports = {
  RATE_LIMIT_PATTERN_NAMES,
  createMessageProcessor,
  resolveAutoResponse,
};
