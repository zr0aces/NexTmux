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

module.exports = { createWatcherEngine };
