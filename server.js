require("dotenv").config();
const http = require("http");
const net = require("net");
const { execSync, execFileSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { DEFAULT_PATTERNS, createPatternEngine, extractResetTime, parseResetEpoch } = require("./lib/patternEngine");
const { createTelegramService } = require("./lib/telegramService");
const { createSessionStateManager } = require("./lib/sessionStateManager");
const { createWatcherEngine, getNewLinesCount, cleanRateLimitLine } = require("./lib/watcherEngine");
const { createMessageProcessor, RATE_LIMIT_PATTERN_NAMES } = require("./lib/messageProcessor");

const { sanitizeSessionName, tmuxExec, tmuxExecAsync, isAlive } = require("./lib/tmuxService");
const {
  SESSION_TTL_MS,
  timingSafePasswordMatch,
  createSession,
  auth,
  buildAuthCookie,
  isLoginRateLimited,
  recordFailedLogin,
  clearFailedLogin,
} = require("./lib/authService");


const PORT = process.env.PORT || 8081;
const PASSWORD = process.env.DASHBOARD_PASSWORD || "changeme";
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const ENABLE_TUNNEL_HEALTHCHECK = process.env.ENABLE_TUNNEL_HEALTHCHECK === "1";
const DISCORD_ALERT_WEBHOOK = process.env.DISCORD_ALERT_WEBHOOK;
const ALERT_WEBHOOK = DISCORD_ALERT_WEBHOOK || DISCORD_WEBHOOK;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
// ENABLE_TUNNEL: env takes precedence; config fallback resolved after loadConfig()
// Resolved into TUNNEL_ENABLED below, after appConfig is loaded.



if (PASSWORD === "changeme") {
  console.warn("⚠️  Using default password. Please set DASHBOARD_PASSWORD environment variable.");
}

const workers = new Map();
let nextId = 1;
let tunnelUrl = null;
let tunnelProcess = null;
let tunnelHealthFailures = 0;
let cachedTunnelUrl = null;
const ACTION_WINDOW_MS = 7000;
const SHELL_COMMANDS = new Set(["bash", "zsh", "sh", "fish"]);
const issueAlertTime = new Map(); // key: alert key, value: timestamp
const ISSUE_ALERT_COOLDOWN_MS = 120000; // 120s cooldown per issue key
const RATE_LIMIT_PATTERNS = RATE_LIMIT_PATTERN_NAMES;

function loadConfig() {
  const configPath = path.join(__dirname, "config.json");
  if (!fs.existsSync(configPath)) return {};
  try {
    if (!fs.statSync(configPath).isFile()) return {};
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value) === "1" || String(value).toLowerCase() === "true";
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function buildMonitorConfig(config) {
  const cfg = config?.aiMonitor || {};
  return {
    enabled: toBool(process.env.AI_MONITOR_ENABLED, cfg.enabled !== false),
    pollIntervalMs: Math.max(250, toNumber(process.env.AI_MONITOR_POLL_INTERVAL_MS, cfg.pollIntervalMs || 1000)),
    idleThresholdMs: Math.max(1000, toNumber(process.env.AI_MONITOR_IDLE_THRESHOLD_MS, cfg.idleThresholdMs || 5000)),
    linesToInspect: Math.max(10, toNumber(process.env.AI_MONITOR_LINES_TO_SCAN, cfg.linesToInspect || 120)),
    notifyCooldownMs: Math.max(1000, toNumber(process.env.AI_MONITOR_NOTIFY_COOLDOWN_MS, cfg.notifyCooldownMs || 120000)),
    patterns: Array.isArray(cfg.patterns) && cfg.patterns.length ? cfg.patterns : DEFAULT_PATTERNS,
  };
}

const appConfig = loadConfig();

// Resolve tunnel toggle: ENABLE_TUNNEL env takes precedence; fallback to config.tunnel.enabled;
// default true to preserve backward compatibility for users who already have cloudflared.
let TUNNEL_ENABLED;
if (process.env.ENABLE_TUNNEL !== undefined && process.env.ENABLE_TUNNEL !== "") {
  TUNNEL_ENABLED = process.env.ENABLE_TUNNEL !== "0";
} else {
  TUNNEL_ENABLED = appConfig.tunnel?.enabled !== false;
}

const monitorConfig = buildMonitorConfig(appConfig);
const patternEngine = createPatternEngine({
  patterns: monitorConfig.patterns,
  linesToInspect: monitorConfig.linesToInspect,
});
const sessionStateManager = createSessionStateManager({
  notifyCooldownMs: monitorConfig.notifyCooldownMs,
  stateFilePath: path.join(__dirname, "state", "session-state.json"),
});
const watcherEngine = createWatcherEngine({
  messageProcessor: createMessageProcessor({
    patternEngine,
    linesToInspect: monitorConfig.linesToInspect,
  }),
  options: { enabled: monitorConfig.enabled, idleThresholdMs: monitorConfig.idleThresholdMs },
});
const telegramService = createTelegramService({
  botToken: TELEGRAM_BOT_TOKEN,
  chatId: TELEGRAM_CHAT_ID,
});

function getBaseCommand(cmd) {
  if (!cmd) return "";
  return String(cmd).trim().split(/\s+/)[0] || "";
}

function rememberAction(w, type, detail) {
  w.lastAction = { type, detail, ts: Date.now() };
}

function recentAction(w) {
  if (!w || !w.lastAction) return null;
  if (Date.now() - w.lastAction.ts > ACTION_WINDOW_MS) return null;
  return w.lastAction;
}

function inferExitReason(w, fallback) {
  const action = recentAction(w);
  if (action?.type === "stop_button") return "Stopped from dashboard (Stop button).";
  if (action?.type === "special_key" && action.detail === "C-c") return "Interrupted by Ctrl+C sent from dashboard.";
  if (action?.type === "special_key") return `Exited after key input from dashboard (${action.detail}).`;
  if (w?.status === "completed" && w?.lastPaneCommand && w?.expectedCmd && w.lastPaneCommand !== w.expectedCmd) {
    return `Command '${w.expectedCmd}' is no longer active (pane now '${w.lastPaneCommand}').`;
  }
  return fallback || "Session exited (reason unknown).";
}



function startPolling(id) {
  const w = workers.get(id);
  if (!w) return;
  if (w.pollTimer) clearInterval(w.pollTimer);
  w.pollTimer = setInterval(() => pollOutput(id), monitorConfig.pollIntervalMs);
}

function initializeWorkerMonitorState(worker) {
  if (!worker) return;
  worker.lastActivityAt = worker.lastActivityAt || null;
  worker.waitingState = worker.waitingState || "running";
  worker.lastMatchedPattern = worker.lastMatchedPattern || null;
  worker.lastPromptExcerpt = worker.lastPromptExcerpt || null;
  worker.lastNotificationAt = worker.lastNotificationAt || null;
  worker.notificationStatus = worker.notificationStatus || null;
  worker.lastAutoResponseKey = worker.lastAutoResponseKey || null;
  worker.aiMonitorEnabled = worker.aiMonitorEnabled !== undefined ? worker.aiMonitorEnabled : monitorConfig.enabled;
  worker.autoMode = worker.autoMode !== undefined ? worker.autoMode : false;
  sessionStateManager.hydrateWorker(worker);
  if (worker.autoMode && worker.aiMonitorEnabled === false) worker.aiMonitorEnabled = true;
  worker.aiState = worker.waitingState;
}

function getMonitorMeta(worker) {
  return sessionStateManager.getApiMeta(worker);
}

function broadcastMonitorMeta(id) {
  const worker = workers.get(id);
  if (!worker) return;
  const nextMeta = getMonitorMeta(worker);
  const nextKey = JSON.stringify(nextMeta);
  if (worker.lastMetaBroadcastKey === nextKey) return;
  worker.lastMetaBroadcastKey = nextKey;
  broadcast({ type: "monitorMeta", id, ...nextMeta });
}

function spawnWorker(cwd, cmd) {
  cmd = cmd || appConfig.defaultCommand || "claude";
  const id = String(nextId++);
  const sessionName = "term-" + id;
  tmuxExec("new-session", "-d", "-s", sessionName, "-c", cwd, "-e", "CLAUDECODE=");
  tmuxExec("send-keys", "-t", sessionName, cmd, "Enter");
  const logs = [];
  workers.set(id, {
    sessionName,
    cwd,
    cmd,
    logs,
    status: "running",
    expectedCmd: getBaseCommand(cmd),
    seenExpectedCmd: false,
    exitReason: null,
    lastPaneCommand: null,
    lastAction: null,
  });
  initializeWorkerMonitorState(workers.get(id));
  startPolling(id);
  broadcast({ type: "spawned", id, cwd, cmd, status: "running", sessionName, ...getMonitorMeta(workers.get(id)) });
  return id;
}

function sendIssueAlert({ key, title, description, color = 0xf0ad4e, fields = [] }) {
  if (!ALERT_WEBHOOK) return;
  const now = Date.now();
  const lastTime = issueAlertTime.get(key) || 0;
  if (now - lastTime < ISSUE_ALERT_COOLDOWN_MS) return;
  issueAlertTime.set(key, now);

  const embed = {
    embeds: [{
      title,
      description,
      color,
      fields,
      timestamp: new Date().toISOString(),
    }],
  };

  fetch(ALERT_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(embed),
  }).catch((err) => {
    console.error("Discord alert failed:", err.message);
  });
}

function sendWaitingAlert(id, detection, now = Date.now()) {
  const w = workers.get(id);
  if (!w) return;

  const decision = sessionStateManager.shouldNotify({
    worker: w,
    patternName: detection?.patternName || "waiting",
    matchedText: detection?.matchedText || "",
    excerpt: detection?.excerpt || "",
    now,
  });
  if (!decision.shouldSend) {
    const status = decision.reason === "duplicate" ? "skipped_duplicate" : "skipped_debounce";
    sessionStateManager.markNotification(w, status, now);
    broadcastMonitorMeta(id);
    return;
  }

  telegramService.sendWaitingNotification({
    sessionName: w.sessionName,
    patternName: detection?.patternName,
    matchedText: detection?.matchedText,
    excerpt: detection?.excerpt || w.lastPromptExcerpt || "",
    resetTime: extractResetTime(detection?.excerpt || "") || w.tokenResetAt || null,
    timestamp: new Date(now).toISOString(),
  }).then((result) => {
    if (result.ok) {
      sessionStateManager.markNotification(w, "sent", now, decision.key);
    } else if (result.skipped) {
      sessionStateManager.markNotification(w, "skipped", now);
    } else {
      sessionStateManager.markNotification(w, "failed", now);
      console.warn("Telegram waiting alert failed", String(w.sessionName), String(result.error || "unknown_error"));
    }
    broadcastMonitorMeta(id);
  }).catch((err) => {
    sessionStateManager.markNotification(w, "failed", now);
    broadcastMonitorMeta(id);
    console.warn("Telegram waiting alert exception", String(w.sessionName), String(err?.message || err));
  });
}

const lastCapture = new Map(); // workerId → last captured tmux output string

async function resizeWorker(id, cols, rows) {
  const w = workers.get(String(id));
  if (!w) return;
  w.cols = cols;
  w.rows = rows;
  
  if (!isAlive(w.sessionName)) return;

  const c = cols || 80;
  const r = rows || 50;

  if (c !== w._lastCols || r !== w._lastRows) {
    tmuxExec("resize-pane", "-t", w.sessionName, "-x", String(c), "-y", String(r));
    tmuxExec("resize-window", "-t", w.sessionName, "-x", String(c), "-y", String(r));
    w._lastCols = c;
    w._lastRows = r;
  }

  try {
    const output = await tmuxExecAsync("capture-pane", "-t", w.sessionName, "-p", "-S", "-500", "-J");
    lastCapture.set(String(id), output);
    const lines = output.split("\n");
    w.logs = lines.slice(-200).map(text => ({ src: "stdout", text, ts: Date.now() }));
    broadcast({ type: "snapshot", id: String(id), lines });
  } catch (e) {
    console.error("Failed to capture pane after resize:", e);
  }
}

async function pollOutput(id) {
  const w = workers.get(id);
  if (!w || w._polling) return;  // skip if a previous poll cycle hasn't finished
  w._polling = true;
  try {
  if (!isAlive(w.sessionName)) {
    if (w.pollTimer) clearInterval(w.pollTimer);
    w.pollTimer = null;
    w.status = 'completed';
    w.aiState = null;
    sessionStateManager.setWaitingState(w, "disconnected");
    w.exitReason = w.exitReason || inferExitReason(w, "tmux session ended or was killed externally.");
    broadcast({ type: "status", id, status: "completed", reason: w.exitReason });
    broadcastMonitorMeta(id);
    return;
  }
  const cols = w.cols || 80;
  const rows = w.rows || 50;
  // Only resize when dimensions actually changed to avoid unnecessary tmux calls
  if (cols !== w._lastCols || rows !== w._lastRows) {
    tmuxExec("resize-pane", "-t", w.sessionName, "-x", String(cols), "-y", String(rows));
    tmuxExec("resize-window", "-t", w.sessionName, "-x", String(cols), "-y", String(rows));
    w._lastCols = cols;
    w._lastRows = rows;
  }
  const output = await tmuxExecAsync("capture-pane", "-t", w.sessionName, "-p", "-S", "-500", "-J");
  const newLinesCount = getNewLinesCount(output, lastCapture.get(id));
  w.totalLinesCount = (w.totalLinesCount || 0) + newLinesCount;

  // Fetch cwd and pane command in a single async tmux call (saves one sub-process per poll)
  const _info = (await tmuxExecAsync("display-message", "-t", w.sessionName, "-p", "#{pane_current_path}|||#{pane_current_command}")).trim().split("|||");
  const currentCwd = _info[0] || "";
  const currentPaneCmd = _info[1] || "";
  if (currentCwd && currentCwd !== w.cwd) {
    w.cwd = currentCwd;
    broadcast({ type: "cwd", id, cwd: currentCwd });
  }
  if (currentPaneCmd) {
    w.lastPaneCommand = currentPaneCmd;
    if (w.expectedCmd && currentPaneCmd === w.expectedCmd) w.seenExpectedCmd = true;
    const switchedToShell = w.seenExpectedCmd && currentPaneCmd !== w.expectedCmd && SHELL_COMMANDS.has(currentPaneCmd);
    if (switchedToShell && w.status !== "completed") {
      if (w.pollTimer) clearInterval(w.pollTimer);
      w.pollTimer = null;
      w.status = "completed";
      w.aiState = null;
      sessionStateManager.setWaitingState(w, "disconnected");
      w.exitReason = inferExitReason(w, `Command '${w.expectedCmd}' exited and returned to shell '${currentPaneCmd}'.`);
      broadcast({ type: "status", id, status: "completed", reason: w.exitReason });
      broadcastMonitorMeta(id);
      return;
    }
  }

  const now = Date.now();

  if (w.aiState === "waiting" && w.resetAtEpochMs && now >= w.resetAtEpochMs) {
    sessionStateManager.clearResetEpoch(w);
    w.tokenResetAt = null;

    // Find the rate limit line in the current output to ignore on next ticks
    const lines = output.split("\n");
    let foundLineIndex = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      const looksRateLimited = /(?:rate[-_\s]*limit|usage[-_\s]*limit|token[-_\s]*limit|daily[-_\s]*limit|you(?:'|’|re| are|\s)+(?:rate[-_\s]*limited|out of.*uses))/i.test(line);
      if (looksRateLimited) {
        foundLineIndex = i;
        break;
      }
    }
    if (foundLineIndex !== -1) {
      w.lastRateLimitAbsLine = (w.totalLinesCount || 0) - (lines.length - foundLineIndex);
    }

    if (w.autoMode) {
      w.aiState = "running";
      sessionStateManager.setWaitingState(w, "running");
      broadcast({ type: "aiState", id, state: "running" });
      sendInput(id, "continue");
    }
    broadcastMonitorMeta(id);
    return;
  }

  const inspectOutput = cleanRateLimitLine(output, w.totalLinesCount, w.lastRateLimitAbsLine);
  const previousInspectOutput = cleanRateLimitLine(lastCapture.get(id), (w.totalLinesCount || 0) - newLinesCount, w.lastRateLimitAbsLine);

  const inspect = w.aiMonitorEnabled && monitorConfig.enabled
    ? watcherEngine.inspect({
        output: inspectOutput,
        previousOutput: previousInspectOutput,
        currentState: w.aiState || "running",
        lastChangeTime: w.lastChangeTime,
        now,
      })
    : { changed: false, nextState: null, detection: null };

  if (inspect.changed) {
    lastCapture.set(id, output);
    w.lastChangeTime = now;
    sessionStateManager.updateActivity(w, now);
    const lines = output.split("\n");
    w.logs = lines.slice(-200).map(text => ({ src: "stdout", text, ts: now }));
    broadcast({ type: "snapshot", id, lines });
  }

  if (inspect.detection?.matched) {
    sessionStateManager.updateMatch(w, inspect.detection);
    const detectionExcerpt = String(inspect.detection.excerpt || "");
    const maybeRateLimitContext = RATE_LIMIT_PATTERNS.has(inspect.detection.patternName)
      || /(?:rate\s*limit|usage\s*limit|token\s*limit|you(?:'|’)ve hit your limit|resets?\s)/i.test(detectionExcerpt);
    if (maybeRateLimitContext) {
      const resetTime = extractResetTime(inspect.detection.excerpt);
      if (resetTime) {
        w.tokenResetAt = resetTime;
        const epoch = parseResetEpoch(resetTime, now);
        if (epoch) {
          sessionStateManager.setResetEpoch(w, epoch);
          w.lastRateLimitAbsLine = undefined; // clear recovery ignore on new rate limit
        }
      }
    }
  }

  const nextState = inspect.nextState || "running";
  const stateChanged = nextState !== w.aiState;
  if (stateChanged) {
    w.aiState = nextState;
    broadcast({ type: "aiState", id, state: nextState });
  }

  if (nextState !== "waiting") {
    w.lastAutoResponseKey = null;
  }

  if (nextState === "waiting" || nextState === "idle" || nextState === "running") {
    sessionStateManager.setWaitingState(w, nextState);
  }

  if (inspect.detection?.matched && nextState === "waiting" && (stateChanged || inspect.changed)) {
    sendWaitingAlert(id, inspect.detection, now);
  }

  if (nextState === "waiting" && w.autoMode && inspect.detection?.matched && (stateChanged || inspect.changed)) {
    const responseKey = [
      inspect.detection.patternName || "",
      inspect.detection.matchedText || "",
    ].join("::");
    if (!stateChanged && responseKey && w.lastAutoResponseKey === responseKey) {
      broadcastMonitorMeta(id);
      return;
    }
    const autoResponse = inspect.detection?.autoResponse;
    if (autoResponse !== null) {
      sendInput(id, autoResponse);
      w.lastAutoResponseKey = responseKey || String(now);
    }
  }

  broadcastMonitorMeta(id);
  } catch (e) {
    // Swallow poll errors to prevent the interval from dying silently
  } finally {
    if (w) w._polling = false;
  }
}

function sendInput(id, text) {
  const w = workers.get(id);
  if (!w) return false;
  if (w.status === "completed") {
    w.status = "running";
    w.aiState = null;
    w.exitReason = null;
    sessionStateManager.setWaitingState(w, "running");
    startPolling(id);
    broadcast({ type: "status", id, status: "running", reason: null });
    broadcastMonitorMeta(id);
  }
  const lines = text.split("\n");
  for (const line of lines) {
    tmuxExec("send-keys", "-t", w.sessionName, line, "");
    tmuxExec("send-keys", "-t", w.sessionName, "", "Enter");
  }
  rememberAction(w, "input", "text");
  broadcast({ type: "log", id, src: "stdin", text, ts: Date.now() });
  return true;
}

function killWorker(id, reason) {
  const w = workers.get(id);
  if (!w) return false;
  if (w.pollTimer) clearInterval(w.pollTimer);
  w.pollTimer = null;
  rememberAction(w, "stop_button", "kill-session");
  tmuxExec("kill-session", "-t", w.sessionName);
  w.status = 'stopped';
  w.aiState = null;
  sessionStateManager.setWaitingState(w, "disconnected");
  w.exitReason = reason || "Stopped from dashboard.";
  broadcast({ type: "status", id, status: "stopped", reason: w.exitReason });
  broadcastMonitorMeta(id);
  return true;
}

let wss;
function broadcast(obj) {
  if (!wss) return;
  const msg = JSON.stringify(obj);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

// Cache static assets at startup to avoid repeated disk I/O per request
const indexHtml = fs.readFileSync(path.join(__dirname, "index.html"));
const staticCache = new Map(); // ext → Buffer

function readBody(req, maxBytes = 65536) {
  return new Promise((res, rej) => {
    let buf = "";
    let size = 0;
    req.on("data", c => {
      size += c.length;
      if (size > maxBytes) { req.destroy(); rej(new Error("request body too large")); return; }
      buf += c;
    });
    req.on("end", () => res(buf));
  });
}

async function parseBody(req) {
  try {
    return { ok: true, body: JSON.parse(await readBody(req)) };
  } catch {
    return { ok: false, body: null };
  }
}

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}



const server = http.createServer(async (req, res) => {
  try {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer-when-downgrade");

    const { method } = req;
    const url = req.url.split("?")[0];

  if (method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" });
    return res.end();
  }

  if (method === "POST" && url === "/api/login") {
    if (isLoginRateLimited(req)) return json(res, 429, { ok: false, error: "too_many_attempts" });
    const { ok, body } = await parseBody(req);
    if (!ok || !body) return json(res, 400, { error: "invalid request body" });
    if (timingSafePasswordMatch(PASSWORD, body.pw)) {
      const token = createSession();
      clearFailedLogin(req);
      res.writeHead(200, { "Set-Cookie": buildAuthCookie(req, token), "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }
    recordFailedLogin(req);
    return json(res, 401, { ok: false });
  }

  if (method === "GET" && url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(indexHtml);
  }

  const MIME = { ".css": "text/css", ".js": "application/javascript" };
  const ext = path.extname(url);
  if (method === "GET" && MIME[ext]) {
    const safePath = path.normalize(url).replace(/^(\.\.[\/\\])+/, '');
    const filePath = path.join(__dirname, "public", safePath);
    if (filePath.startsWith(path.join(__dirname, "public")) && fs.existsSync(filePath)) {
      if (!staticCache.has(filePath)) staticCache.set(filePath, fs.readFileSync(filePath));
      res.writeHead(200, { "Content-Type": MIME[ext] + "; charset=utf-8" });
      return res.end(staticCache.get(filePath));
    }
  }

  if (method === "GET" && url === "/api/config") {
    if (!auth(req)) return json(res, 401, { error: "unauthorized" });
    const configPath = path.join(__dirname, "config.json");
    let config = {};
    if (fs.existsSync(configPath)) {
      try {
        config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      } catch {
        config = {};
      }
    }
    const safeConfig = {
      basePath: config.basePath,
      favorites: Array.isArray(config.favorites) ? config.favorites : [],
      defaultCommand: typeof config.defaultCommand === "string" ? config.defaultCommand : undefined,
      aiMonitor: config.aiMonitor && typeof config.aiMonitor === "object" ? {
        enabled: config.aiMonitor.enabled !== false,
        pollIntervalMs: config.aiMonitor.pollIntervalMs,
        idleThresholdMs: config.aiMonitor.idleThresholdMs,
        linesToInspect: config.aiMonitor.linesToInspect,
        notifyCooldownMs: config.aiMonitor.notifyCooldownMs,
      } : undefined,
    };
    return json(res, 200, safeConfig);
  }

  if (!auth(req)) return json(res, 401, { error: "unauthorized" });

  if (method === "GET" && url === "/api/workers") {
    const list = [...workers.entries()].map(([id, w]) => ({
      id,
      cwd: w.cwd,
      cmd: w.cmd || "claude",
      status: (w.status === "completed" || w.status === "stopped") ? w.status : (isAlive(w.sessionName) ? "running" : (w.status || "stopped")),
      sessionName: w.sessionName,
      logs: w.logs,
      aiState: w.aiState || null,
      exitReason: w.exitReason || null,
      ...getMonitorMeta(w),
    }));
    return json(res, 200, list);
  }

  if (method === "GET" && url === "/api/scan") {
    const raw = tmuxExec("ls", "-F", "#{session_name}|#{pane_current_path}");
    const existingNames = new Set([...workers.values()].map(w => w.sessionName));
    const found = [];
    for (const line of raw.trim().split("\n")) {
      if (!line) continue;
      const [sessionName, cwd] = line.split("|");
      if (existingNames.has(sessionName)) continue;
      found.push({ sessionName, cwd: cwd || "unknown" });
    }
    return json(res, 200, found);
  }

  if (method === "POST" && url === "/api/attach") {
    const { ok, body } = await parseBody(req);
    if (!ok || !body) return json(res, 400, { error: "invalid request body" });
    const rawSessionName = String(body.sessionName || "");
    let sessionName;
    try {
      sessionName = sanitizeSessionName(rawSessionName);
    } catch {
      return json(res, 400, { error: "invalid sessionName" });
    }
    const cwd = body.cwd;
    // Guard: if a worker already tracks this sessionName, return its existing id
    // to prevent duplicate tabs polling the same tmux pane.
    const existingEntry = [...workers.entries()].find(([, w]) => w.sessionName === sessionName);
    if (existingEntry) return json(res, 200, { id: existingEntry[0] });
    const id = String(nextId++);
    workers.set(id, {
      sessionName,
      cwd,
      logs: [],
      status: "running",
      exitReason: null,
      expectedCmd: "",
      seenExpectedCmd: false,
      lastPaneCommand: null,
      lastAction: null,
    });
    initializeWorkerMonitorState(workers.get(id));
    startPolling(id);
    broadcast({ type: "spawned", id, cwd, status: "running", sessionName, ...getMonitorMeta(workers.get(id)) });
    return json(res, 200, { id });
  }

  if (method === "POST" && url === "/api/spawn") {
    const { ok, body } = await parseBody(req);
    if (!ok || !body) return json(res, 400, { error: "invalid request body" });
    const rawCwd = body.cwd || process.cwd();
    const resolvedCwd = path.resolve(rawCwd);
    try {
      const stat = fs.statSync(resolvedCwd);
      if (!stat.isDirectory()) {
        return json(res, 400, { ok: false, error: "Invalid path: not a directory." });
      }
    } catch (e) {
      return json(res, 400, { ok: false, error: "Invalid path: does not exist or not accessible." });
    }
    const id = spawnWorker(resolvedCwd, body.cmd);
    return json(res, 200, { ok: true, id });
  }

  if (method === "POST" && url === "/api/input") {
    const { ok, body } = await parseBody(req);
    if (!ok || !body) return json(res, 400, { error: "invalid request body" });
    const { id, text } = body;
    const inputOk = sendInput(id, text);
    return json(res, 200, { ok: inputOk });
  }

  if (method === "POST" && url === "/api/remove") {
    const { ok, body } = await parseBody(req);
    if (!ok || !body) return json(res, 400, { error: "invalid request body" });
    const { id } = body;
    const w = workers.get(id);
    if (w) {
      if (w.pollTimer) clearInterval(w.pollTimer);
      sessionStateManager.removeSession(w.sessionName);
      workers.delete(id);
      lastCapture.delete(id);
    }
    return json(res, 200, { ok: true });
  }

  if (method === "POST" && url === "/api/key") {
    const { ok, body } = await parseBody(req);
    if (!ok || !body) return json(res, 400, { error: "invalid request body" });
    const { id, key } = body;
    const w = workers.get(id);
    if (w) {
      if (w.status === "completed") {
        w.status = "running";
        w.aiState = null;
        w.exitReason = null;
        sessionStateManager.setWaitingState(w, "running");
        startPolling(id);
        broadcast({ type: "status", id, status: "running", reason: null });
        broadcastMonitorMeta(id);
      }
      rememberAction(w, "special_key", key);
      tmuxExec("send-keys", "-t", w.sessionName, String(key));
    }
    return json(res, 200, { ok: true });
  }

  if (method === "POST" && url === "/api/reconnect") {
    const { ok, body } = await parseBody(req);
    if (!ok || !body) return json(res, 400, { error: "invalid request body" });
    const { id } = body;
    const w = workers.get(id);
    if (!w) return json(res, 404, { ok: false });
    if (isAlive(w.sessionName)) {
      if (w.pollTimer) clearInterval(w.pollTimer);
      w.status = "running";
      w.aiState = null;
      w.exitReason = null;
      w.seenExpectedCmd = false;
      sessionStateManager.setWaitingState(w, "running");
      startPolling(id);
      broadcast({ type: "status", id, status: "running", reason: null });
      broadcastMonitorMeta(id);
      return json(res, 200, { ok: true });
    }
    return json(res, 200, { ok: false });
  }

  if (method === "POST" && url === "/api/reset") {
    const { ok, body } = await parseBody(req);
    if (!ok || !body) return json(res, 400, { error: "invalid request body" });
    const { id } = body;
    const w = workers.get(id);
    if (!w) return json(res, 404, { ok: false });
    if (isAlive(w.sessionName)) {
      if (w.pollTimer) clearInterval(w.pollTimer);
      
      // 1. Remove session from sessionStateManager snapshot on disk
      sessionStateManager.removeSession(w.sessionName);
      
      // 2. Reset worker in-memory tracking & AI monitoring properties
      w.status = "running";
      w.aiState = null;
      w.exitReason = null;
      w.seenExpectedCmd = false;
      w.lastPaneCommand = null;
      w.lastAction = null;
      w.tokenResetAt = null;
      w.resetAtEpochMs = null;
      w.lastRateLimitAbsLine = undefined;
      w.lastAutoResponseKey = null;
      w.notifiedMessageHashes = [];
      w.sentNotificationKeys = new Set();
      w.logs = [];

      // 3. Clear cached last capture to force re-reading the whole tmux pane
      lastCapture.delete(id);

      // 4. Update the state in the sessionStateManager
      sessionStateManager.setWaitingState(w, "running");
      sessionStateManager.clearResetEpoch(w);

      // 5. Restart polling
      startPolling(id);

      // 6. Broadcast all changes to the client
      broadcast({ type: "status", id, status: "running", reason: null });
      broadcast({ type: "aiState", id, state: "running" });
      broadcast({ type: "snapshot", id, lines: [] });
      broadcastMonitorMeta(id);

      return json(res, 200, { ok: true });
    }
    return json(res, 200, { ok: false, error: "tmux session not alive" });
  }

  if (method === "POST" && url === "/api/toggle-ai-monitor") {
    const { ok, body } = await parseBody(req);
    if (!ok || !body) return json(res, 400, { error: "invalid request body" });
    const { id } = body;
    const w = workers.get(id);
    if (!w) return json(res, 404, { ok: false });
    const enabled = sessionStateManager.toggleAiMonitor(w);
    broadcast({ type: "monitorMeta", id, ...getMonitorMeta(w) });
    return json(res, 200, { ok: true, enabled });
  }

  if (method === "POST" && url === "/api/toggle-auto-mode") {
    const { ok, body } = await parseBody(req);
    if (!ok || !body) return json(res, 400, { error: "invalid request body" });
    const { id } = body;
    const w = workers.get(id);
    if (!w) return json(res, 404, { ok: false });
    const enabled = sessionStateManager.toggleAutoMode(w);
    broadcast({ type: "monitorMeta", id, ...getMonitorMeta(w) });
    return json(res, 200, { ok: true, enabled });
  }

  if (method === "POST" && url === "/api/set-monitor-mode") {
    const { ok, body } = await parseBody(req);
    if (!ok || !body) return json(res, 400, { error: "invalid request body" });
    const { id, mode } = body;
    const w = workers.get(id);
    if (!w) return json(res, 404, { ok: false });
    const nextMode = sessionStateManager.setMonitorMode(w, mode);
    if (!nextMode) return json(res, 400, { ok: false, error: "invalid monitor mode" });
    broadcast({ type: "monitorMeta", id, ...getMonitorMeta(w) });
    return json(res, 200, { ok: true, mode: nextMode });
  }

  if (method === "GET" && url === "/api/git-diff") {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const workerId = params.get('id');
    const file = params.get('file');

    const w = workers.get(workerId);
    if (!w) return json(res, 404, { error: 'worker not found' });

    // Prevent path traversal
    if (file) {
      const resolvedPath = path.resolve(w.cwd, file);
      if (!resolvedPath.startsWith(path.resolve(w.cwd))) {
        return json(res, 400, { error: 'invalid file path' });
      }
    }

    const cwd = w.cwd;

    const execOpts = { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, stdio: 'pipe' };
    try {
      // Verify this is a git repository
      execFileSync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], execOpts);

      if (file) {
        // Per-file diff — against HEAD when available, otherwise against the working tree
        let diff = '';
        try {
          diff = execFileSync('git', ['-C', cwd, '--no-color', 'diff', 'HEAD', '--', file], execOpts);
        } catch (_) {
          diff = execFileSync('git', ['-C', cwd, '--no-color', 'diff', '--', file], execOpts);
        }
        return json(res, 200, { diff });
      } else {
        // File list: git status --porcelain (includes untracked files)
        const status = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], execOpts);
        const files = status.trim().split('\n').filter(Boolean).map(line => {
          const xy = line.substring(0, 2).trim();
          const filePath = line.substring(3);
          // Status mapping: M=modified, A=added, D=deleted, ?=untracked (new), R=renamed
          let s = 'M';
          if (xy === '??') s = 'A';
          else if (xy.includes('D')) s = 'D';
          else if (xy.includes('A')) s = 'A';
          else if (xy.includes('R')) s = 'R';
          return { status: s, path: filePath };
        });

        let stat = '';
        try {
          stat = execFileSync('git', ['-C', cwd, '--no-color', 'diff', '--stat', 'HEAD'], execOpts).trim();
        } catch (_) { /* no HEAD yet */ }

        return json(res, 200, { files, stat });
      }
    } catch (e) {
      return json(res, 200, { files: [], diff: '', stat: '', error: e.message || 'not a git repo' });
    }
  }

  if (method === "GET" && url === "/api/tunnel") {
    return json(res, 200, { url: tunnelUrl });
  }

  if (method === "POST" && url === "/api/kill") {
    const { ok, body } = await parseBody(req);
    if (!ok || !body) return json(res, 400, { error: "invalid request body" });
    const { id } = body;
    killWorker(id, "Stopped from dashboard (Stop button).");
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: "not found" });
  } catch (err) {
    console.error("HTTP request error:", err);
    if (!res.writableEnded) {
      json(res, 500, { error: "internal_server_error", message: err.message });
    }
  }
});

wss = new WebSocketServer({ server });
const clientSizes = new Map();
wss.on('connection', (ws, req) => {
  if (!auth(req)) {
    ws.close(1008, "unauthorized");
    return;
  }
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'resize') {
        const size = { cols: msg.cols, rows: msg.rows };
        clientSizes.set(ws, size);
        if (msg.id && workers.has(String(msg.id))) {
          resizeWorker(String(msg.id), size.cols, size.rows);
        } else {
          workers.forEach(w => {
            resizeWorker(w.id, size.cols, size.rows);
          });
        }
      }
      if (msg.type === 'active') {
        const size = clientSizes.get(ws);
        if (size) {
          workers.forEach(w => {
            resizeWorker(w.id, size.cols, size.rows);
          });
        }
      }
    } catch (e) {}
  });
  ws.on('close', () => clientSizes.delete(ws));
});

const heartbeatInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.on('close', () => {
  clearInterval(heartbeatInterval);
});


function recoverSessions() {
  const raw = tmuxExec("ls", "-F", "#{session_name}|#{pane_current_path}|#{pane_current_command}");
  if (!raw.trim()) return;
  const recovered = [];
  for (const line of raw.trim().split("\n")) {
    if (!line) continue;
    const parts = line.split("|");
    const sessionName = parts[0];
    const cwd = parts[1] || "unknown";
    const cmd = parts[2] || "unknown";
    if (!sessionName.startsWith("term-")) continue;
    const id = sessionName.replace("term-", "");
    const numId = parseInt(id);
    if (isNaN(numId)) continue;
    try { sanitizeSessionName(sessionName); } catch { continue; }
    if (workers.has(id)) continue;
    workers.set(id, {
      sessionName,
      cwd,
      cmd,
      logs: [],
      status: "running",
      expectedCmd: getBaseCommand(cmd),
      seenExpectedCmd: false,
      exitReason: null,
      lastPaneCommand: null,
      lastAction: null,
    });
    initializeWorkerMonitorState(workers.get(id));
    startPolling(id);
    if (numId >= nextId) nextId = numId + 1;
    recovered.push(id);
  }
  if (recovered.length > 0) {
    console.log(`♻️  Recovered ${recovered.length} session(s)`);
    // Broadcast spawned events so already-connected clients (e.g. fast
    // reconnect after crash-restart) see recovered sessions without a page reload.
    recovered.forEach(id => {
      const w = workers.get(id);
      if (w) broadcast({ type: "spawned", id, cwd: w.cwd, cmd: w.cmd, status: "running", sessionName: w.sessionName, ...getMonitorMeta(w) });
    });
  }
}

function startTunnel() {
  try {
    execSync("which cloudflared", { stdio: "pipe" });
  } catch {
    console.log("☁️  cloudflared not found — skipping tunnel");
    sendIssueAlert({
      key: "tunnel-cloudflared-missing",
      title: "🚨 Tunnel Unavailable",
      description: "cloudflared is not installed, so external tunnel cannot start.",
      color: 0xe74c3c,
      fields: [{ name: "Issue", value: "cloudflared not found in PATH", inline: false }],
    });
    return;
  }
  tunnelProcess = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${PORT}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const handleData = (data) => {
    const text = data.toString();
    const matches = [...text.matchAll(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com/gi)];
    const valid = matches.find((m) => m[1] && m[1].toLowerCase() !== "api");
    if (valid) {
      const nextUrl = valid[0];
      if (cachedTunnelUrl === nextUrl) return;
      const changed = cachedTunnelUrl && cachedTunnelUrl !== nextUrl;
      cachedTunnelUrl = nextUrl;
      tunnelUrl = nextUrl;
      tunnelHealthFailures = 0;
      if (changed) {
        console.log(`☁️  Tunnel URL changed → ${tunnelUrl}`);
      } else {
        console.log(`☁️  Tunnel URL → ${tunnelUrl}`);
      }
      broadcast({ type: "tunnel", url: tunnelUrl });
      if (DISCORD_WEBHOOK) {
        fetch(DISCORD_WEBHOOK, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: `☁️ TmuxHub → ${tunnelUrl}` }),
        }).catch(() => {});
      }
    }
  };
  tunnelProcess.stdout.on("data", handleData);
  tunnelProcess.stderr.on("data", handleData);
  tunnelProcess.on("close", (code) => {
    console.log(`☁️  cloudflared exited (code ${code}), restarting in 5s...`);
    sendIssueAlert({
      key: `tunnel-exit-${code}`,
      title: "⚠️ Tunnel Restarted",
      description: `cloudflared exited with code ${code}. Restarting in 5 seconds.`,
      color: code === 0 ? 0xf39c12 : 0xe67e22,
      fields: [
        { name: "Issue", value: "Tunnel process exited unexpectedly.", inline: false },
        { name: "Exit Code", value: String(code), inline: true },
        { name: "Last URL", value: tunnelUrl || cachedTunnelUrl || "unknown", inline: true },
      ],
    });
    tunnelUrl = null;
    cachedTunnelUrl = null;
    tunnelProcess = null;
    tunnelHealthFailures = 0;
    setTimeout(startTunnel, 5000);
  });
}



function checkTunnel() {
  if (!cachedTunnelUrl || !tunnelProcess) return;
  fetch(cachedTunnelUrl, { signal: AbortSignal.timeout(10000), cache: "no-store" })
    .then(r => {
      if (!r.ok) throw new Error(r.status);
      tunnelHealthFailures = 0;
    })
    .catch((err) => {
      tunnelHealthFailures += 1;
      const reason = err?.cause?.code || err?.code || err?.message || String(err);
      console.log(`☁️  Tunnel health check failed (${tunnelHealthFailures}/5): ${reason}`);
      if (tunnelHealthFailures >= 5) {
        console.log("☁️  Tunnel health check threshold reached, restarting...");
        const processAlive = tunnelProcess && !tunnelProcess.killed && tunnelProcess.exitCode === null;
        const uptimeMin = Math.floor(process.uptime() / 60);
        sendIssueAlert({
          key: "tunnel-healthcheck-threshold",
          title: "🚨 Tunnel Healthcheck Failure",
          description: "5 consecutive tunnel health checks failed. Restarting cloudflared.",
          color: 0xe74c3c,
          fields: [
            { name: "Error", value: reason, inline: false },
            { name: "Tunnel URL", value: cachedTunnelUrl || "unknown", inline: false },
            { name: "cloudflared alive", value: processAlive ? "Yes" : "No", inline: true },
            { name: "Server uptime", value: `${uptimeMin}m`, inline: true },
          ],
        });
        tunnelHealthFailures = 0;
        if (tunnelProcess) tunnelProcess.kill();
      }
    });
}

server.listen(PORT, () => {
  recoverSessions();
  console.log(`✅ TmuxHub running → http://localhost:${PORT}`);
  console.log("🔑 Password is configured via DASHBOARD_PASSWORD");
  console.log(`📺 View tmux session: tmux attach -t term-1`);
  console.log(`👀 AI monitor: ${monitorConfig.enabled ? "enabled" : "disabled"} (poll=${monitorConfig.pollIntervalMs}ms, lines=${monitorConfig.linesToInspect})`);
  console.log(`📨 Telegram alerts: ${telegramService.enabled ? "configured" : "not configured"}`);
  if (TUNNEL_ENABLED) {
    startTunnel();
  } else {
    console.log("☁️  Tunnel disabled (set ENABLE_TUNNEL=1 or tunnel.enabled=true in config.json to enable)");
  }
  if (ENABLE_TUNNEL_HEALTHCHECK) {
    setInterval(checkTunnel, 60000);
  } else {
    console.log("☁️  Tunnel health check disabled (set ENABLE_TUNNEL_HEALTHCHECK=1 to enable)");
  }
});

process.on("SIGINT", () => {
  if (tunnelProcess) tunnelProcess.kill();
  process.exit();
});
process.on("SIGTERM", () => {
  if (tunnelProcess) tunnelProcess.kill();
  process.exit();
});
