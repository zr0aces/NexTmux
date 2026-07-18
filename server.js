require("dotenv").config();
const http = require("http");
const net = require("net");
const { execSync, execFileSync, spawn, execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { DEFAULT_PATTERNS, createPatternEngine, extractResetTime, parseResetEpoch } = require("./lib/patternEngine");
const { createTelegramService } = require("./lib/telegramService");
const { createSessionStateManager } = require("./lib/sessionStateManager");
const { createWatcherEngine, getNewLinesCount, cleanRateLimitLine } = require("./lib/watcherEngine");
const { createMessageProcessor, RATE_LIMIT_PATTERN_NAMES } = require("./lib/messageProcessor");
const SessionManager = require("./lib/sessionManager");
const TunnelManager = require("./lib/tunnelManager");

const { sanitizeSessionName, tmuxExec, tmuxExecAsync, isAlive, resolveSessionId } = require("./lib/tmuxService");
const { parseGlobalPaneInfo } = require("./lib/paneInfoParser");
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
const versionPath = path.join(__dirname, "VERSION");
let APP_VERSION = "2026.6.7";
if (fs.existsSync(versionPath)) {
  APP_VERSION = fs.readFileSync(versionPath, "utf8").trim();
}
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

let tunnelUrl = null;
const ACTION_WINDOW_MS = 7000;
const SHELL_COMMANDS = new Set(["bash", "zsh", "sh", "fish"]);
const issueAlertTime = new Map(); // key: alert key, value: timestamp
const ISSUE_ALERT_COOLDOWN_MS = 120000; // 120s cooldown per issue key
const RATE_LIMIT_PATTERNS = RATE_LIMIT_PATTERN_NAMES;

function gitExecAsync(cwd, args, maxBuffer = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

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
    cliProfiles: config?.cliProfiles || {},
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

const sessionManager = new SessionManager({
  monitorConfig,
  appConfig,
  watcherEngine,
  sessionStateManager,
  telegramService,
  onEvent: (event) => broadcast(event),
  extractResetTime,
  parseResetEpoch,
  cleanRateLimitLine,
  getNewLinesCount,
  RATE_LIMIT_PATTERNS: RATE_LIMIT_PATTERN_NAMES,
});

const tunnelManager = new TunnelManager({
  port: PORT,
  tunnelEnabled: TUNNEL_ENABLED,
  healthcheckEnabled: ENABLE_TUNNEL_HEALTHCHECK,
  onUrlChange: (url) => {
    tunnelUrl = url;
    broadcast({ type: "tunnel", url });
    if (DISCORD_WEBHOOK) {
      fetch(DISCORD_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: `☁️ NexTmux → ${url}` }),
      }).catch(() => {});
    }
  },
  onAlert: (alert) => sendIssueAlert(alert),
});

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

// resizeWorker, pollOutput, sendInput and killWorker have moved to SessionManager/Worker.

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
    req.on("error", err => rej(err));
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
    res.setHeader("X-App-Version", APP_VERSION);

    const { method } = req;
    const url = req.url.split("?")[0];

  if (method === "OPTIONS") {
    res.writeHead(204);
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
    try {
      const liveHtml = await fs.promises.readFile(path.join(__dirname, "index.html"));
      return res.end(liveHtml);
    } catch {
      return res.end(indexHtml);
    }
  }

  const MIME = { ".css": "text/css", ".js": "application/javascript" };
  const ext = path.extname(url);
  if (method === "GET" && MIME[ext]) {
    const safePath = path.normalize(url).replace(/^(\.\.[\/\\])+/, '');
    const filePath = path.join(__dirname, "public", safePath);
    const publicRoot = path.join(__dirname, "public" + path.sep);
    if (filePath.startsWith(publicRoot)) {
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.isFile()) {
          const fileContent = await fs.promises.readFile(filePath);
          res.writeHead(200, { "Content-Type": MIME[ext] + "; charset=utf-8" });
          return res.end(fileContent);
        }
      } catch (err) {
        // Fall through to 404
      }
    }
  }

  if (method === "GET" && url === "/api/config") {
    if (!auth(req)) return json(res, 401, { error: "unauthorized" });
    const configPath = path.join(__dirname, "config.json");
    let config = {};
    try {
      const data = await fs.promises.readFile(configPath, "utf8");
      config = JSON.parse(data);
    } catch {
      config = {};
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
    const list = sessionManager.getWorkersList();
    return json(res, 200, list);
  }

  if (method === "GET" && url === "/api/scan") {
    const raw = tmuxExec("ls", "-F", "#{session_name}|#{pane_current_path}|#{session_id}");
    const found = [];
    for (const line of raw.trim().split("\n")) {
      if (!line) continue;
      const parts = line.split("|");
      const sessionName = parts[0];
      const cwd = parts[1] || "unknown";
      const sessionId = parts[2] ? parts[2].trim() : null;
      if (sessionManager.findSession(sessionName, sessionId)) continue;
      found.push({ sessionName, cwd });
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
    const id = sessionManager.attachWorker(sessionName, cwd);
    return json(res, 200, { id });
  }

  if (method === "POST" && url === "/api/spawn") {
    const { ok, body } = await parseBody(req);
    if (!ok || !body) return json(res, 400, { error: "invalid request body" });
    const rawCwd = body.cwd || process.cwd();
    const resolvedCwd = path.resolve(rawCwd);
    try {
      const stat = await fs.promises.stat(resolvedCwd);
      if (!stat.isDirectory()) {
        return json(res, 400, { ok: false, error: "Invalid path: not a directory." });
      }
    } catch (e) {
      return json(res, 400, { ok: false, error: "Invalid path: does not exist or not accessible." });
    }
    const id = sessionManager.spawnWorker(resolvedCwd, body.cmd);
    return json(res, 200, { ok: true, id });
  }

  if (method === "POST" && url === "/api/input") {
    const { ok, body } = await parseBody(req);
    if (!ok || !body) return json(res, 400, { error: "invalid request body" });
    const { id, text } = body;
    if ((typeof id !== "string" && typeof id !== "number") || typeof text !== "string") {
      return json(res, 400, { ok: false, error: "invalid input payload" });
    }
    const inputOk = sessionManager.sendInput(id, text);
    return json(res, 200, { ok: inputOk });
  }

  if (method === "POST" && url === "/api/remove") {
    const { ok, body } = await parseBody(req);
    if (!ok || !body) return json(res, 400, { error: "invalid request body" });
    const { id } = body;
    sessionManager.removeWorker(id);
    return json(res, 200, { ok: true });
  }

  if (method === "POST" && url === "/api/key") {
    const { ok, body } = await parseBody(req);
    if (!ok || !body) return json(res, 400, { error: "invalid request body" });
    const { id, key } = body;
    const keyOk = sessionManager.sendKey(id, key);
    return json(res, 200, { ok: keyOk });
  }

  if (method === "POST" && url === "/api/reconnect") {
    const { ok, body } = await parseBody(req);
    if (!ok || !body) return json(res, 400, { error: "invalid request body" });
    const { id } = body;
    const okRec = sessionManager.reconnectWorker(id);
    return json(res, 200, { ok: okRec });
  }

  if (method === "POST" && url === "/api/reset") {
    const { ok, body } = await parseBody(req);
    if (!ok || !body) return json(res, 400, { error: "invalid request body" });
    const { id } = body;
    const okReset = sessionManager.resetWorker(id);
    return json(res, 200, { ok: okReset });
  }

  if (method === "POST" && url === "/api/toggle-ai-monitor") {
    const { ok, body } = await parseBody(req);
    if (!ok || !body) return json(res, 400, { error: "invalid request body" });
    const { id } = body;
    const enabled = sessionManager.toggleAiMonitor(id);
    if (enabled === null) return json(res, 404, { ok: false });
    return json(res, 200, { ok: true, enabled });
  }

  if (method === "POST" && url === "/api/toggle-auto-mode") {
    const { ok, body } = await parseBody(req);
    if (!ok || !body) return json(res, 400, { error: "invalid request body" });
    const { id } = body;
    const enabled = sessionManager.toggleAutoMode(id);
    if (enabled === null) return json(res, 404, { ok: false });
    return json(res, 200, { ok: true, enabled });
  }

  if (method === "POST" && url === "/api/set-monitor-mode") {
    const { ok, body } = await parseBody(req);
    if (!ok || !body) return json(res, 400, { error: "invalid request body" });
    const { id, mode } = body;
    const nextMode = sessionManager.setMonitorMode(id, mode);
    if (nextMode === null) return json(res, 400, { ok: false, error: "invalid monitor mode or worker not found" });
    return json(res, 200, { ok: true, mode: nextMode });
  }

  if (method === "GET" && url === "/api/git-diff") {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const workerId = params.get('id');
    const file = params.get('file');

    const w = sessionManager.get(workerId);
    if (!w) return json(res, 404, { error: 'worker not found' });

    // Prevent path traversal
    if (file) {
      const cwdRoot = path.resolve(w.cwd);
      const resolvedPath = path.resolve(cwdRoot, file);
      const relative = path.relative(cwdRoot, resolvedPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return json(res, 400, { error: 'invalid file path' });
      }
    }

    const cwd = w.cwd;

    try {
      // Verify this is a git repository
      await gitExecAsync(cwd, ['rev-parse', '--is-inside-work-tree']);

      if (file) {
        // Per-file diff — against HEAD when available, otherwise against the working tree
        let diff = '';
        try {
          diff = await gitExecAsync(cwd, ['--no-color', 'diff', 'HEAD', '--', file]);
        } catch (_) {
          diff = await gitExecAsync(cwd, ['--no-color', 'diff', '--', file]);
        }
        return json(res, 200, { diff });
      } else {
        // File list: git status --porcelain (includes untracked files)
        const status = await gitExecAsync(cwd, ['status', '--porcelain']);
        const files = status.trim().split('\n').filter(Boolean).map(line => {
          const xy = line.substring(0, 2).trim();
          let filePath = line.substring(3);
          // Status mapping: M=modified, A=added, D=deleted, ?=untracked (new), R=renamed
          let s = 'M';
          if (xy === '??') s = 'A';
          else if (xy.includes('D')) s = 'D';
          else if (xy.includes('A')) s = 'A';
          else if (xy.includes('R')) {
            s = 'R';
            if (filePath.includes(" -> ")) {
              filePath = filePath.split(" -> ").pop().trim().replace(/^"(.*)"$/, '$1');
            }
          }
          return { status: s, path: filePath };
        });

        let stat = '';
        try {
          stat = (await gitExecAsync(cwd, ['--no-color', 'diff', '--stat', 'HEAD'])).trim();
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
    sessionManager.killWorker(id, "Stopped from dashboard (Stop button).");
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
        if (msg.id && sessionManager.has(String(msg.id))) {
          sessionManager.resizeWorker(String(msg.id), size.cols, size.rows);
        } else {
          sessionManager.forEach((_, workerId) => {
            sessionManager.resizeWorker(String(workerId), size.cols, size.rows);
          });
        }
      }
      if (msg.type === 'active') {
        const size = clientSizes.get(ws);
        if (size) {
          sessionManager.forEach((_, workerId) => {
            sessionManager.resizeWorker(String(workerId), size.cols, size.rows);
          });
        }
      }
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      console.warn("WS message handling failed:", msg);
    }
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


// recoverSessions is now handled inside SessionManager.init().

// startTunnel and checkTunnel are now managed by TunnelManager.

server.listen(PORT, () => {
  sessionManager.init();
  console.log(`✅ NexTmux running → http://localhost:${PORT}`);
  console.log("🔑 Password is configured via DASHBOARD_PASSWORD");
  console.log(`📺 View tmux session: tmux attach -t term-1`);
  console.log(`👀 AI monitor: ${monitorConfig.enabled ? "enabled" : "disabled"} (poll=${monitorConfig.pollIntervalMs}ms, lines=${monitorConfig.linesToInspect})`);
  console.log(`📨 Telegram alerts: ${telegramService.enabled ? "configured" : "not configured"}`);
  
  tunnelManager.start();
});

process.on("SIGINT", () => {
  tunnelManager.stop();
  process.exit();
});
process.on("SIGTERM", () => {
  tunnelManager.stop();
  process.exit();
});
