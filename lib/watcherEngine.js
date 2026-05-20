function createWatcherEngine({ patternEngine, options = {} } = {}) {
  const enabled = options.enabled !== false;
  const idleThresholdMs = Math.max(1000, Number(options.idleThresholdMs) || 5000);

  function inspect({ output, previousOutput, currentState, lastChangeTime, now = Date.now() }) {
    const changed = output !== previousOutput;
    if (!enabled) {
      return {
        changed,
        detection: { matched: false, patternName: null, matchedText: "", excerpt: "", detectedAt: null },
        nextState: currentState || "running",
      };
    }

    const detection = patternEngine.detect(output || "");

    if (changed) {
      return {
        changed: true,
        detection,
        nextState: detection.matched ? "waiting" : "running",
      };
    }

    const elapsed = lastChangeTime ? now - lastChangeTime : 0;
    if (elapsed >= idleThresholdMs) {
      return {
        changed: false,
        detection,
        nextState: detection.matched ? "waiting" : "idle",
      };
    }

    return {
      changed: false,
      detection,
      nextState: currentState || "running",
    };
  }

  return {
    enabled,
    inspect,
  };
}

function getNewLinesCount(currentOutput, previousOutput) {
  if (!previousOutput) return currentOutput.split("\n").length;
  if (currentOutput === previousOutput) return 0;
  
  const prevLines = previousOutput.split("\n");
  const currLines = currentOutput.split("\n");
  
  const maxSearch = Math.min(prevLines.length, currLines.length);
  for (let overlap = maxSearch; overlap > 0; overlap--) {
    let match = true;
    for (let i = 0; i < overlap; i++) {
      if (prevLines[prevLines.length - overlap + i] !== currLines[i]) {
        match = false;
        break;
      }
    }
    if (match) {
      return currLines.length - overlap;
    }
  }
  return currLines.length;
}

function cleanRateLimitLine(text, totalLinesCount, lastRateLimitAbsLine) {
  if (!text || lastRateLimitAbsLine === undefined) return text;
  const lines = text.split("\n");
  const linesBefore = (totalLinesCount || 0) - lastRateLimitAbsLine;
  const lineIndex = lines.length - linesBefore;
  if (lineIndex >= 0 && lineIndex < lines.length) {
    const cleanLines = [...lines];
    cleanLines[lineIndex] = "";
    return cleanLines.join("\n");
  }
  return text;
}

module.exports = {
  createWatcherEngine,
  getNewLinesCount,
  cleanRateLimitLine,
};
