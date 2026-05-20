const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createPatternEngine } = require("../lib/patternEngine");
const { createMessageProcessor } = require("../lib/messageProcessor");
const { createWatcherEngine } = require("../lib/watcherEngine");

function createProcessorWithoutPatterns() {
  const patternEngine = createPatternEngine({ patterns: [] });
  return createMessageProcessor({ patternEngine });
}

test("messageProcessor detects yes/no prompts and returns y", () => {
  const processor = createProcessorWithoutPatterns();
  const detection = processor.detect("Apply this change? [y/N]");
  assert.equal(detection.matched, true);
  assert.equal(detection.patternName, "yes_no");
  assert.equal(detection.autoResponse, "y");
});

test("messageProcessor detects numbered selection prompt and chooses Yes option", () => {
  const processor = createProcessorWithoutPatterns();
  const detection = processor.detect("Select an option:\n1. Yes\n2. No");
  assert.equal(detection.matched, true);
  assert.equal(detection.patternName, "numbered_selection");
  assert.equal(detection.autoResponse, "1");
});

test("messageProcessor supports bracketed selectable patterns like [1] Yes", () => {
  const processor = createProcessorWithoutPatterns();
  const detection = processor.detect("Pick one:\n[1] Yes\n[2] No");
  assert.equal(detection.matched, true);
  assert.equal(detection.patternName, "numbered_selection");
  assert.equal(detection.autoResponse, "1");
});

test("messageProcessor selects rate-limit wait option 1 when available", () => {
  const processor = createProcessorWithoutPatterns();
  const detection = processor.detect("/rate-limit-options\n1. Stop and wait for limit to reset\n2. Exit");
  assert.equal(detection.matched, true);
  assert.equal(detection.patternName, "rate_limit_options");
  assert.equal(detection.autoResponse, "1");
});

test("messageProcessor does not auto-respond on plain rate-limit notifications", () => {
  const patternEngine = createPatternEngine();
  const processor = createMessageProcessor({ patternEngine });
  const detection = processor.detect("You're out of free uses for today. Try again in 2 hours.");
  assert.equal(detection.matched, true);
  assert.equal(detection.patternName, "rate_limited");
  assert.equal(detection.autoResponse, null);
});

test("messageProcessor returns Enter for press-enter prompts", () => {
  const processor = createProcessorWithoutPatterns();
  const detection = processor.detect("Press Enter to continue");
  assert.equal(detection.matched, true);
  assert.equal(detection.patternName, "press_enter");
  assert.equal(detection.autoResponse, "");
});

test("watcherEngine uses shared message processor detection flow", () => {
  const messageProcessor = createProcessorWithoutPatterns();
  const watcherEngine = createWatcherEngine({
    messageProcessor,
    options: { enabled: true, idleThresholdMs: 1000 },
  });
  const result = watcherEngine.inspect({
    output: "Choose an option:\n1. Yes\n2. No",
    previousOutput: "",
    currentState: "running",
    lastChangeTime: Date.now(),
  });
  assert.equal(result.nextState, "waiting");
  assert.equal(result.detection.matched, true);
  assert.equal(result.detection.autoResponse, "1");
});
