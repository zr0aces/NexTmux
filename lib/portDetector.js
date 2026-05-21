"use strict";
// ── portDetector.js ──
// Localhost port detection for the Preview feature: scans terminal output for
// port references, probes whether they are actually listening, checks content
// type, and manages per-port cloudflared preview tunnels.

const http = require("http");
const net = require("net");
const { spawn } = require("child_process");

// Well-known infrastructure service ports — excluded from preview detection
const EXCLUDED_PORTS = new Set([
  3306,  // MySQL
  5432,  // PostgreSQL
  5433,
  27017, // MongoDB
  27018, 27019,
  6379,  // Redis
  6380,
  5672,  // RabbitMQ
  15672,
  9200,  // Elasticsearch
  9300,
  2181,  // ZooKeeper
  2375,  // Docker daemon
  2376,
]);

const PORT_PATTERN = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):(\d{2,5})/g;

// workerId → Set<number> : ports confirmed listening per worker
const detectedPorts = new Map();
// workerId → Set<number> : ports seen in output but not yet confirmed
const pendingPorts = new Map();
// port → { process, url } : cloudflared tunnel state per port
const previewTunnels = new Map();

function checkPortListening(port) {
  function tryConnect(host) {
    return new Promise(resolve => {
      const sock = new net.Socket();
      sock.setTimeout(500);
      sock.once("connect", () => { sock.destroy(); resolve(true); });
      sock.once("error", () => resolve(false));
      sock.once("timeout", () => { sock.destroy(); resolve(false); });
      sock.connect(port, host);
    });
  }
  return tryConnect("127.0.0.1").then(ok => ok ? true : tryConnect("::1"));
}

function checkContentType(port) {
  return new Promise(resolve => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path: "/", timeout: 2000 },
      res => {
        const ct = (res.headers["content-type"] || "").toLowerCase();
        res.resume();
        resolve(ct.includes("text/html") ? "html" : ct || "unknown");
      }
    );
    req.on("error", () => resolve("error"));
    req.on("timeout", () => { req.destroy(); resolve("timeout"); });
  });
}

/**
 * Scan terminal output for port references and probe each one.
 * @param {string} id - worker ID
 * @param {string} output - raw terminal output
 * @param {number} dashboardPort - the TmuxHub server port (excluded from detection)
 * @param {boolean} previewTunnelEnabled - whether to start cloudflared per port
 * @param {function} broadcast - function to send WS messages to all clients
 */
function detectPorts(id, output, dashboardPort, previewTunnelEnabled, broadcast) {
  const matches = [...output.matchAll(PORT_PATTERN)];
  if (!matches.length && (!pendingPorts.has(id) || !pendingPorts.get(id).size)) return;

  if (!detectedPorts.has(id)) detectedPorts.set(id, new Set());
  if (!pendingPorts.has(id)) pendingPorts.set(id, new Set());
  const portSet = detectedPorts.get(id);
  const pending = pendingPorts.get(id);

  for (const m of matches) {
    const port = parseInt(m[1], 10);
    if (port < 1024 || port > 65535) continue;
    if (port === Number(dashboardPort)) continue;
    if (EXCLUDED_PORTS.has(port)) continue;
    if (portSet.has(port)) continue;
    pending.add(port);
  }

  for (const port of [...pending]) {
    pending.delete(port);
    checkPortListening(port).then(listening => {
      if (!listening) { pending.add(port); return; }
      if (portSet.has(port)) return;
      portSet.add(port);

      for (const [wid, pset] of detectedPorts) {
        if (wid !== id && pset.has(port)) return;
      }

      checkContentType(port).then(ct => {
        if (ct === "html") {
          broadcast({ type: "preview_detected", workerId: id, port });
        } else {
          broadcast({ type: "preview_prompt", workerId: id, port, contentType: ct });
        }
        if (previewTunnelEnabled) startPreviewTunnel(port, broadcast);
      });
    });
  }
}

function startPreviewTunnel(port, broadcast) {
  if (previewTunnels.has(port)) return;
  try {
    require("child_process").execFileSync("which", ["cloudflared"], { stdio: "pipe" });
  } catch {
    return;
  }

  const proc = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  previewTunnels.set(port, { process: proc, url: null });

  const handleData = data => {
    const text = data.toString();
    const matches = [...text.matchAll(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com/gi)];
    const valid = matches.find(m => m[1] && m[1].toLowerCase() !== "api");
    if (valid) {
      const url = valid[0];
      const entry = previewTunnels.get(port);
      if (entry && entry.url !== url) {
        entry.url = url;
        broadcast({ type: "preview_tunnel", port, url });
      }
    }
  };
  proc.stdout.on("data", handleData);
  proc.stderr.on("data", handleData);
  proc.on("close", () => previewTunnels.delete(port));
}

function cleanupPreviewPorts(workerId) {
  const portSet = detectedPorts.get(workerId);
  if (!portSet) return;
  for (const port of portSet) {
    let usedByOther = false;
    for (const [wid, pset] of detectedPorts) {
      if (wid !== workerId && pset.has(port)) { usedByOther = true; break; }
    }
    if (!usedByOther) {
      const tunnel = previewTunnels.get(port);
      if (tunnel) { tunnel.process.kill(); previewTunnels.delete(port); }
    }
  }
  detectedPorts.delete(workerId);
  pendingPorts.delete(workerId);
}

module.exports = {
  detectPorts,
  cleanupPreviewPorts,
  startPreviewTunnel,
  detectedPorts,
  previewTunnels,
  checkPortListening,
};
