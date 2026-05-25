const { test } = require("node:test");
const assert = require("node:assert/strict");

// Mock server functions for testing
function detectCliType(cmd) {
  const normalized = String(cmd || "").toLowerCase().trim();
  const baseCmd = normalized.split(/\s+|\//)[0];
  
  if (baseCmd === "claude" || normalized.includes("claude")) return "claude";
  if (baseCmd === "codex" || normalized.includes("codex")) return "codex";
  if (baseCmd === "agy" || normalized.includes("agy") || normalized.includes("antigravity")) return "agy";
  
  return null;
}

function convertCliProfilePatterns(profile) {
  if (!profile || typeof profile !== "object" || !profile.patterns) {
    return [];
  }
  
  const result = [];
  for (const [name, regex] of Object.entries(profile.patterns)) {
    if (!regex) continue;
    
    if (Array.isArray(regex)) {
      regex.forEach((r, i) => {
        if (typeof r === "string") {
          result.push({
            name: `${name}${i > 0 ? `_alt${i}` : ""}`,
            regex: r,
          });
        }
      });
    } else if (typeof regex === "string") {
      result.push({ name, regex });
    }
  }
  return result;
}

// Tests
test("detectCliType - identifies claude from simple command", () => {
  assert.equal(detectCliType("claude"), "claude");
});

test("detectCliType - identifies codex from simple command", () => {
  assert.equal(detectCliType("codex"), "codex");
});

test("detectCliType - identifies agy from simple command", () => {
  assert.equal(detectCliType("agy"), "agy");
});

test("detectCliType - identifies antigravity as agy", () => {
  assert.equal(detectCliType("antigravity"), "agy");
});

test("detectCliType - extracts claude from full command path", () => {
  assert.equal(detectCliType("/usr/local/bin/claude --model claude-opus"), "claude");
});

test("detectCliType - extracts codex from full command path", () => {
  assert.equal(detectCliType("/opt/openai/codex --api-key xyz"), "codex");
});

test("detectCliType - returns null for unknown CLI", () => {
  assert.equal(detectCliType("unknown-cli"), null);
});

test("detectCliType - case insensitive", () => {
  assert.equal(detectCliType("CLAUDE"), "claude");
  assert.equal(detectCliType("Codex"), "codex");
  assert.equal(detectCliType("AgY"), "agy");
});

test("convertCliProfilePatterns - converts single regex pattern", () => {
  const profile = {
    patterns: {
      rate_limit: "rate limit"
    }
  };
  const result = convertCliProfilePatterns(profile);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "rate_limit");
  assert.equal(result[0].regex, "rate limit");
});

test("convertCliProfilePatterns - converts array of regex patterns", () => {
  const profile = {
    patterns: {
      rate_limit: ["pattern1", "pattern2"]
    }
  };
  const result = convertCliProfilePatterns(profile);
  assert.equal(result.length, 2);
  assert.equal(result[0].name, "rate_limit");
  assert.equal(result[1].name, "rate_limit_alt1");
});

test("convertCliProfilePatterns - handles multiple pattern groups", () => {
  const profile = {
    patterns: {
      rate_limit: ["pattern1"],
      usage_exceeded: "pattern2",
      approval_needed: ["pattern3", "pattern4"]
    }
  };
  const result = convertCliProfilePatterns(profile);
  assert.equal(result.length, 4);
});

test("convertCliProfilePatterns - returns empty array for null profile", () => {
  const result = convertCliProfilePatterns(null);
  assert.equal(result.length, 0);
});

test("convertCliProfilePatterns - skips null/undefined patterns", () => {
  const profile = {
    patterns: {
      rate_limit: "pattern1",
      unused: null,
      approval: undefined
    }
  };
  const result = convertCliProfilePatterns(profile);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "rate_limit");
});
