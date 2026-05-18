require("dotenv").config();
const http = require("http");
const net = require("net");
const { execSync, execFileSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { DEFAULT_PATTERNS, createPatternEngine } = require("./lib/patternEngine");
const { createTelegramService } = require("./lib/telegramService");
const { createSessionStateManager } = require("./lib/sessionStateManager");
const { createWatcherEngine } = require("./lib/watcherEngine");

const PORT = process.env.PORT || 8081;
const PASSWORD = process.env.DASHBOARD_PASSWORD || "changeme";
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const ENABLE_TUNNEL_HEALTHCHECK = process.env.ENABLE_TUNNEL_HEALTHCHECK === "1";
const DISCORD_ALERT_WEBHOOK = process.env.DISCORD_ALERT_WEBHOOK;
const ALERT_WEBHOOK = DISCORD_ALERT_WEBHOOK || DISCORD_WEBHOOK;
const ENABLE_PREVIEW = process.env.ENABLE_PREVIEW === "1";
const PREVIEW_TUNNEL = process.env.PREVIEW_TUNNEL === "1";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// workerId(문자열) → Set<number> : 워커별 감지된 포트 목록
const detectedPorts = new Map();
// port(number) → { process, url } : 포트별 cloudflared 터널 상태
const previewTunnels = new Map();
// localhost 포트 감지 정규식
const PORT_PATTERN = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):(\d{2,5})/g;

if (PASSWORD === "changeme") {
  console.warn("⚠️  Using default password. Please set DASHBOARD_PASSWORD environment variable.");
}

const sessions = new Map();
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

function createToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function isAlive(sessionName) {
  try {
    execSync(`tmux has-session -t ${sessionName}`, { encoding: "utf8", stdio: "pipe" });
    return true;
  } catch (e) {
    return false;
  }
}

function tmux(cmd) {
  try { return execSync("tmux " + cmd, { encoding: "utf8", stdio: "pipe" }); }
  catch (e) { return ""; }
}

function loadConfig() {
  const configPath = path.join(__dirname, "config.json");
  return fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
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
  patternEngine,
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

// DB·인프라 서비스의 대표 포트 — 미리보기 대상에서 제외 (false positive 방지)
const EXCLUDED_PORTS = new Set([
  3306,  // MySQL
  5432,  // PostgreSQL
  5433,  // PostgreSQL (alt)
  27017, // MongoDB
  27018, 27019,
  6379,  // Redis
  6380,
  5672,  // RabbitMQ
  15672, // RabbitMQ management
  9200,  // Elasticsearch
  9300,
  2181,  // ZooKeeper
  2375,  // Docker daemon
  2376,
]);

function checkPortListening(port) {
  function tryConnect(host) {
    return new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setTimeout(500);
      sock.once("connect", () => { sock.destroy(); resolve(true); });
      sock.once("error", () => resolve(false));
      sock.once("timeout", () => { sock.destroy(); resolve(false); });
      sock.connect(port, host);
    });
  }
  // IPv4 먼저, 실패하면 IPv6
  return tryConnect("127.0.0.1").then((ok) => ok ? true : tryConnect("::1"));
}

// Content-Type 체크: HTML이면 프론트엔드로 판단
function checkContentType(port) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: "/", timeout: 2000 }, (res) => {
      const ct = (res.headers["content-type"] || "").toLowerCase();
      res.resume(); // 응답 body 소비 (메모리 누수 방지)
      resolve(ct.includes("text/html") ? "html" : ct || "unknown");
    });
    req.on("error", () => resolve("error"));
    req.on("timeout", () => { req.destroy(); resolve("timeout"); });
  });
}

// 포트 감지됐지만 아직 리스닝 확인 안 된 포트 (워커별)
const pendingPorts = new Map(); // id → Set<port>

function detectPorts(id, output) {
  if (!ENABLE_PREVIEW) return;
  const matches = [...output.matchAll(PORT_PATTERN)];
  if (!matches.length && (!pendingPorts.has(id) || !pendingPorts.get(id).size)) return;

  if (!detectedPorts.has(id)) detectedPorts.set(id, new Set());
  if (!pendingPorts.has(id)) pendingPorts.set(id, new Set());
  const portSet = detectedPorts.get(id);
  const pending = pendingPorts.get(id);

  // 새로 감지된 포트를 pending에 추가
  for (const m of matches) {
    const port = parseInt(m[1], 10);
    if (port < 1024 || port > 65535) continue;
    if (port === Number(PORT)) continue;
    if (EXCLUDED_PORTS.has(port)) continue;
    if (portSet.has(port)) continue;
    pending.add(port);
  }

  // pending 포트들의 리스닝 여부 확인
  for (const port of [...pending]) {
    pending.delete(port);
    checkPortListening(port).then((listening) => {
      if (!listening) {
        pending.add(port);
        return;
      }
      if (portSet.has(port)) return;
      portSet.add(port);

      // 다른 워커에서 이미 감지·브로드캐스트된 포트면 중복 전송하지 않음
      for (const [wid, pset] of detectedPorts) {
        if (wid !== id && pset.has(port)) return;
      }

      // Content-Type 체크: HTML이면 자동 미리보기, 아니면 사용자 선택
      checkContentType(port).then((ct) => {
        if (ct === "html") {
          broadcast({ type: "preview_detected", workerId: id, port });
        } else {
          broadcast({ type: "preview_prompt", workerId: id, port, contentType: ct });
        }
        if (PREVIEW_TUNNEL) startPreviewTunnel(port);
      });
    });
  }
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
  sessionStateManager.hydrateWorker(worker);
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
  const config = loadConfig();
  cmd = cmd || config.defaultCommand || "claude";
  const id = String(nextId++);
  const sessionName = "term-" + id;
  tmux(`new-session -d -s ${sessionName} -c "${cwd}" -e CLAUDECODE=`);
  tmux(`send-keys -t ${sessionName} ${JSON.stringify(cmd)} Enter`);
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
    sessionName: w.sessionName,
    patternName: detection?.patternName || "waiting",
    excerpt: detection?.excerpt || "",
    now,
  });
  if (!decision.shouldSend) {
    sessionStateManager.markNotification(w, "skipped_debounce", now);
    broadcastMonitorMeta(id);
    return;
  }

  telegramService.sendWaitingNotification({
    sessionName: w.sessionName,
    patternName: detection?.patternName,
    matchedText: detection?.matchedText,
    excerpt: detection?.excerpt || w.lastPromptExcerpt || "",
    timestamp: new Date(now).toISOString(),
  }).then((result) => {
    if (result.ok) {
      sessionStateManager.markNotification(w, "sent", now);
    } else if (result.skipped) {
      sessionStateManager.markNotification(w, "skipped_debounce", now);
    } else {
      sessionStateManager.markNotification(w, "failed", now);
      console.warn(`Telegram waiting alert failed for ${w.sessionName}: ${result.error || "unknown_error"}`);
    }
    broadcastMonitorMeta(id);
  }).catch((err) => {
    sessionStateManager.markNotification(w, "failed", now);
    broadcastMonitorMeta(id);
    console.warn(`Telegram waiting alert exception for ${w.sessionName}:`, err?.message || err);
  });
}

let lastCapture = {};

function pollOutput(id) {
  const w = workers.get(id);
  if (!w) return;
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
  tmux(`resize-pane -t ${w.sessionName} -x ${cols} -y ${rows}`);
  tmux(`resize-window -t ${w.sessionName} -x ${cols} -y ${rows}`);
  const output = tmux(`capture-pane -t ${w.sessionName} -p -S -500 -J`);

  // Track actual working directory
  const currentCwd = tmux(`display-message -t ${w.sessionName} -p "#{pane_current_path}"`).trim();
  if (currentCwd && currentCwd !== w.cwd) {
    w.cwd = currentCwd;
    broadcast({ type: "cwd", id, cwd: currentCwd });
  }
  const currentPaneCmd = tmux(`display-message -t ${w.sessionName} -p "#{pane_current_command}"`).trim();
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
  const inspect = watcherEngine.inspect({
    output,
    previousOutput: lastCapture[id],
    currentState: w.aiState || "running",
    lastChangeTime: w.lastChangeTime,
    now,
  });

  // Output unchanged — pending port detection retry
  if (!inspect.changed) {
    detectPorts(id, output);
  } else {
    lastCapture[id] = output;
    detectPorts(id, output);
    w.lastChangeTime = now;
    sessionStateManager.updateActivity(w, now);
    const lines = output.split("\n");
    w.logs = lines.slice(-200).map(text => ({ src: "stdout", text, ts: now }));
    broadcast({ type: "snapshot", id, lines });
  }

  if (inspect.detection?.matched) {
    sessionStateManager.updateMatch(w, inspect.detection);
  }

  const nextState = inspect.nextState || "running";
  const stateChanged = nextState !== w.aiState;
  if (stateChanged) {
    w.aiState = nextState;
    broadcast({ type: "aiState", id, state: nextState });
  }

  if (nextState === "waiting" || nextState === "idle" || nextState === "running") {
    sessionStateManager.setWaitingState(w, nextState);
  }

  if (inspect.detection?.matched && nextState === "waiting" && (stateChanged || inspect.changed)) {
    sendWaitingAlert(id, inspect.detection, now);
  }

  broadcastMonitorMeta(id);
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
    tmux(`send-keys -t ${w.sessionName} "${line.replace(/"/g, '\\"')}" ""`);
    tmux(`send-keys -t ${w.sessionName} "" Enter`);
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
  tmux(`kill-session -t ${w.sessionName}`);
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

function readBody(req) {
  return new Promise(res => {
    let buf = "";
    req.on("data", c => (buf += c));
    req.on("end", () => res(buf));
  });
}

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function auth(req) {
  const cookie = req.headers.cookie || "";
  const token = cookie.split(";").map(s => s.trim()).find(s => s.startsWith("token="))?.slice(6);
  return token && sessions.has(token);
}

const server = http.createServer(async (req, res) => {
  const { method } = req;
  const url = req.url.split("?")[0];

  if (method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" });
    return res.end();
  }

  if (method === "POST" && url === "/api/login") {
    const body = JSON.parse(await readBody(req));
    if (body.pw === PASSWORD) {
      const token = createToken();
      sessions.set(token, true);
      res.writeHead(200, { "Set-Cookie": `token=${token}; Path=/; HttpOnly`, "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }
    return json(res, 401, { ok: false });
  }

  if (method === "GET" && url === "/") {
    const html = fs.readFileSync(path.join(__dirname, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  const MIME = { ".css": "text/css", ".js": "application/javascript" };
  const ext = path.extname(url);
  if (method === "GET" && MIME[ext]) {
    const safePath = path.normalize(url).replace(/^(\.\.[\/\\])+/, '');
    const filePath = path.join(__dirname, "public", safePath);
    if (filePath.startsWith(path.join(__dirname, "public")) && fs.existsSync(filePath)) {
      res.writeHead(200, { "Content-Type": MIME[ext] + "; charset=utf-8" });
      return res.end(fs.readFileSync(filePath));
    }
  }

  if (method === "GET" && url === "/api/config") {
    if (!auth(req)) return json(res, 401, { error: "unauthorized" });
    const configPath = path.join(__dirname, "config.json");
    const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
    return json(res, 200, config);
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
    const raw = tmux("ls -F '#{session_name}|#{pane_current_path}'");
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
    const { sessionName, cwd } = JSON.parse(await readBody(req));
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
    const body = JSON.parse(await readBody(req));
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
    const { id, text } = JSON.parse(await readBody(req));
    const ok = sendInput(id, text);
    return json(res, 200, { ok });
  }

  if (method === "POST" && url === "/api/remove") {
    const { id } = JSON.parse(await readBody(req));
    const w = workers.get(id);
    if (w) {
      if (w.pollTimer) clearInterval(w.pollTimer);
      cleanupPreviewPorts(id);
      sessionStateManager.removeSession(w.sessionName);
      workers.delete(id);
      delete lastCapture[id];
    }
    return json(res, 200, { ok: true });
  }

  if (method === "POST" && url === "/api/key") {
    const { id, key } = JSON.parse(await readBody(req));
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
      tmux(`send-keys -t ${w.sessionName} ${key}`);
    }
    return json(res, 200, { ok: true });
  }

  if (method === "POST" && url === "/api/reconnect") {
    const { id } = JSON.parse(await readBody(req));
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

  if (method === "GET" && url === "/api/git-diff") {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const workerId = params.get('id');
    const file = params.get('file');

    const w = workers.get(workerId);
    if (!w) return json(res, 404, { error: 'worker not found' });

    // path traversal 방지
    if (file && file.includes('..')) return json(res, 400, { error: 'invalid file path' });

    const cwd = w.cwd;

    const execOpts = { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, stdio: 'pipe' };
    try {
      // git repo 확인
      execFileSync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], execOpts);

      if (file) {
        // 특정 파일의 diff — HEAD가 있으면 HEAD 대비, 없으면 워킹트리
        let diff = '';
        try {
          diff = execFileSync('git', ['-C', cwd, '--no-color', 'diff', 'HEAD', '--', file], execOpts);
        } catch (_) {
          diff = execFileSync('git', ['-C', cwd, '--no-color', 'diff', '--', file], execOpts);
        }
        return json(res, 200, { diff });
      } else {
        // 파일 목록: git status --porcelain (untracked 포함)
        const status = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], execOpts);
        const files = status.trim().split('\n').filter(Boolean).map(line => {
          const xy = line.substring(0, 2).trim();
          const filePath = line.substring(3);
          // 상태 매핑: M=수정, A=추가, D=삭제, ?=untracked(신규), R=이름변경
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
    const { id } = JSON.parse(await readBody(req));
    killWorker(id, "Stopped from dashboard (Stop button).");
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: "not found" });
});

wss = new WebSocketServer({ server });
const clientSizes = new Map();
wss.on('connection', ws => {
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'resize') {
        const size = { cols: msg.cols, rows: msg.rows };
        clientSizes.set(ws, size);
        if (msg.id && workers.has(String(msg.id))) {
          const w = workers.get(String(msg.id));
          w.cols = size.cols;
          w.rows = size.rows;
        } else {
          workers.forEach(w => { w.cols = size.cols; w.rows = size.rows; });
        }
      }
      if (msg.type === 'active') {
        const size = clientSizes.get(ws);
        if (size) workers.forEach(w => { w.cols = size.cols; w.rows = size.rows; });
      }
    } catch (e) {}
  });
  ws.on('close', () => clientSizes.delete(ws));

  // 새 클라이언트에게 기존 미리보기 상태 동기화 (리스닝 중인 포트만, 포트 기준 중복 제거)
  if (ws.readyState === 1) {
    const syncedPorts = new Set();
    detectedPorts.forEach((portSet, workerId) => {
      portSet.forEach(port => {
        if (syncedPorts.has(port)) return;
        syncedPorts.add(port);
        checkPortListening(port).then(listening => {
          if (listening) {
            ws.send(JSON.stringify({ type: "preview_detected", workerId, port }));
          } else {
            portSet.delete(port);
          }
        });
      });
    });
    // 이미 생성된 터널 URL 전송
    previewTunnels.forEach((tunnel, port) => {
      if (tunnel.url) {
        ws.send(JSON.stringify({ type: "preview_tunnel", port, url: tunnel.url }));
      }
    });
  }
});


function recoverSessions() {
  const raw = tmux("ls -F '#{session_name}|#{pane_current_path}|#{pane_current_command}'");
  if (!raw.trim()) return;
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
  }
  if (workers.size > 0) {
    console.log(`♻️  Recovered ${workers.size} session(s)`);
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
          body: JSON.stringify({ content: `☁️ TermHub → ${tunnelUrl}` }),
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

function startPreviewTunnel(port) {
  // 이미 해당 포트의 터널이 존재하면 중복 생성 방지
  if (previewTunnels.has(port)) return;

  try {
    execSync("which cloudflared", { stdio: "pipe" });
  } catch {
    console.log(`☁️  cloudflared not found — cannot start preview tunnel for port ${port}`);
    return;
  }

  console.log(`☁️  Starting preview tunnel for port ${port}...`);
  const proc = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // 터널 생성 즉시 Map에 등록 (중복 스폰 방지)
  previewTunnels.set(port, { process: proc, url: null });

  const handleData = (data) => {
    const text = data.toString();
    const matches = [...text.matchAll(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com/gi)];
    const valid = matches.find((m) => m[1] && m[1].toLowerCase() !== "api");
    if (valid) {
      const url = valid[0];
      const entry = previewTunnels.get(port);
      if (entry && entry.url !== url) {
        entry.url = url;
        console.log(`☁️  Preview tunnel port ${port} → ${url}`);
        broadcast({ type: "preview_tunnel", port, url });
      }
    }
  };

  proc.stdout.on("data", handleData);
  proc.stderr.on("data", handleData);
  proc.on("close", () => {
    previewTunnels.delete(port);
  });
}

function cleanupPreviewPorts(workerId) {
  const portSet = detectedPorts.get(workerId);
  if (!portSet) return;

  for (const port of portSet) {
    // 해당 포트를 다른 워커가 사용 중인지 확인
    let usedByOther = false;
    for (const [wid, pset] of detectedPorts) {
      if (wid !== workerId && pset.has(port)) {
        usedByOther = true;
        break;
      }
    }
    if (!usedByOther) {
      const tunnel = previewTunnels.get(port);
      if (tunnel) {
        tunnel.process.kill();
        previewTunnels.delete(port);
      }
    }
  }

  detectedPorts.delete(workerId);
  pendingPorts.delete(workerId);
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
  console.log(`✅ TermHub running → http://localhost:${PORT}`);
  console.log(`🔑 Password: ${PASSWORD}`);
  console.log(`📺 View tmux session: tmux attach -t term-1`);
  console.log(`👀 AI monitor: ${monitorConfig.enabled ? "enabled" : "disabled"} (poll=${monitorConfig.pollIntervalMs}ms, lines=${monitorConfig.linesToInspect})`);
  console.log(`📨 Telegram alerts: ${telegramService.enabled ? "configured" : "not configured"}`);
  startTunnel();
  if (ENABLE_TUNNEL_HEALTHCHECK) {
    setInterval(checkTunnel, 60000);
  } else {
    console.log("☁️  Tunnel health check disabled (set ENABLE_TUNNEL_HEALTHCHECK=1 to enable)");
  }
});

process.on("SIGINT", () => {
  if (tunnelProcess) tunnelProcess.kill();
  previewTunnels.forEach(t => t.process.kill());
  process.exit();
});
process.on("SIGTERM", () => {
  if (tunnelProcess) tunnelProcess.kill();
  previewTunnels.forEach(t => t.process.kill());
  process.exit();
});
