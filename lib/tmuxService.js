"use strict";
// ── tmuxService.js ──
// All tmux subprocess interaction helpers. Keeps server.js focused on routing
// and session orchestration rather than subprocess details.

const { execFileSync, execFile } = require("child_process");

/**
 * Validate and sanitize a tmux session name.
 * Throws if the name contains characters that could be used for injection.
 */
function sanitizeSessionName(name) {
  if (typeof name !== "string" || !/^[a-zA-Z0-9_:-]+$/.test(name)) {
    throw new Error(`Unsafe tmux session name rejected: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Synchronous tmux call. Use for lightweight control operations where
 * blocking is acceptable (kill-session, send-keys, new-session, has-session).
 */
function tmuxExec(...args) {
  try {
    return execFileSync("tmux", args, { encoding: "utf8", stdio: "pipe" });
  } catch {
    return "";
  }
}

/**
 * Async tmux call. Use in the poll loop to avoid blocking the event loop
 * during heavy capture-pane and display-message operations.
 */
function tmuxExecAsync(...args) {
  return new Promise(resolve => {
    execFile("tmux", args, { encoding: "utf8" }, (err, stdout) =>
      resolve(err ? "" : stdout)
    );
  });
}

/**
 * Returns true if the named tmux session currently exists.
 */
function isAlive(sessionName) {
  try {
    execFileSync("tmux", ["has-session", "-t", sessionName], {
      encoding: "utf8",
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

function parseSessionIdFromList(raw, sessionName) {
  if (!raw || !sessionName) return null;
  for (const line of String(raw).split("\n")) {
    if (!line.trim()) continue;
    const pipe = line.indexOf("|");
    if (pipe === -1) continue;
    const name = line.slice(0, pipe);
    const id = line.slice(pipe + 1).trim();
    if (name === sessionName && id) return id;
  }
  return null;
}

function resolveSessionId(sessionName) {
  try {
    const raw = tmuxExec("list-sessions", "-F", "#{session_name}|#{session_id}");
    return parseSessionIdFromList(raw, sessionName);
  } catch {
    return null;
  }
}

module.exports = { sanitizeSessionName, tmuxExec, tmuxExecAsync, isAlive, resolveSessionId, parseSessionIdFromList };
