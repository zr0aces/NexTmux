"use strict";

function parseGlobalPaneInfo(raw) {
  const nextInfo = new Map();
  if (!raw) return nextInfo;
  for (const line of String(raw).trim().split("\n")) {
    if (!line) continue;
    const parts = line.split("|||");
    if (parts.length < 7) continue;
    const sessionName  = parts[0];
    const sessionId    = parts[1];
    const cwd          = parts[2] || "";
    const paneCmd      = parts[3] || "";
    const windowActive = parts[4];
    const paneActive   = parts[5];
    const sessionAttached = parts[6];
    if (windowActive !== "1" || paneActive !== "1") continue;
    nextInfo.set(sessionId, { sessionId, sessionName, cwd, paneCmd, sessionAttached });
  }
  return nextInfo;
}

module.exports = { parseGlobalPaneInfo };
