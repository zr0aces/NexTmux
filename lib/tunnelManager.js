"use strict";
// ── tunnelManager.js ──
// Encapsulates the lifecycle, monitoring, health checks, and auto-restart
// behaviour of the cloudflared tunnel. Decouples server.js from subprocess
// management and SIGINT/SIGTERM handlers.

const { spawn, execSync } = require("child_process");

class TunnelManager {
  constructor({
    port,
    tunnelEnabled = true,
    healthcheckEnabled = false,
    onUrlChange = () => {},
    onAlert = () => {},
    logger = console,
  } = {}) {
    this.port = port;
    this.tunnelEnabled = tunnelEnabled;
    this.healthcheckEnabled = healthcheckEnabled;
    this.onUrlChange = onUrlChange;
    this.onAlert = onAlert;
    this.logger = logger;

    this.tunnelUrl = null;
    this.tunnelProcess = null;
    this.tunnelHealthFailures = 0;
    this.cachedTunnelUrl = null;
    this.healthInterval = null;
    this.reconnectTimeout = null;
    this.isStopping = false;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Start the cloudflared tunnel process if enabled. */
  start() {
    if (!this.tunnelEnabled) {
      this.logger.log("☁️  Tunnel disabled (set ENABLE_TUNNEL=1 or tunnel.enabled=true in config.json to enable)");
      return;
    }

    try {
      execSync("which cloudflared", { stdio: "pipe" });
    } catch {
      this.logger.log("☁️  cloudflared not found — skipping tunnel");
      this.onAlert({
        key: "tunnel-cloudflared-missing",
        title: "🚨 Tunnel Unavailable",
        description: "cloudflared is not installed, so external tunnel cannot start.",
        color: 0xe74c3c,
        fields: [{ name: "Issue", value: "cloudflared not found in PATH", inline: false }],
      });
      return;
    }

    this._startTunnelProcess();

    if (this.healthcheckEnabled) {
      this.healthInterval = setInterval(() => this.checkHealth(), 60000);
    } else {
      this.logger.log("☁️  Tunnel health check disabled (set ENABLE_TUNNEL_HEALTHCHECK=1 to enable)");
    }
  }

  /** Stop the tunnel process and clear all timers. */
  stop() {
    this.isStopping = true;
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.tunnelProcess) {
      this.tunnelProcess.kill();
      this.tunnelProcess = null;
    }
    this.tunnelUrl = null;
    this.cachedTunnelUrl = null;
  }

  /** Run a single tunnel health check query. */
  checkHealth() {
    if (!this.cachedTunnelUrl || !this.tunnelProcess) return;

    fetch(this.cachedTunnelUrl, { signal: AbortSignal.timeout(10000), cache: "no-store" })
      .then(r => {
        if (!r.ok) throw new Error(r.status);
        this.tunnelHealthFailures = 0;
      })
      .catch((err) => {
        this.tunnelHealthFailures += 1;
        const reason = err?.cause?.code || err?.code || err?.message || String(err);
        this.logger.log(`☁️  Tunnel health check failed (${this.tunnelHealthFailures}/5): ${reason}`);
        
        if (this.tunnelHealthFailures >= 5) {
          this.logger.log("☁️  Tunnel health check threshold reached, restarting...");
          const processAlive = this.tunnelProcess && !this.tunnelProcess.killed && this.tunnelProcess.exitCode === null;
          const uptimeMin = Math.floor(process.uptime() / 60);

          this.onAlert({
            key: "tunnel-healthcheck-threshold",
            title: "🚨 Tunnel Healthcheck Failure",
            description: "5 consecutive tunnel health checks failed. Restarting cloudflared.",
            color: 0xe74c3c,
            fields: [
              { name: "Error", value: reason, inline: false },
              { name: "Tunnel URL", value: this.cachedTunnelUrl || "unknown", inline: false },
              { name: "cloudflared alive", value: processAlive ? "Yes" : "No", inline: true },
              { name: "Server uptime", value: `${uptimeMin}m`, inline: true },
            ],
          });

          this.tunnelHealthFailures = 0;
          if (this.tunnelProcess) {
            this.tunnelProcess.kill();
          }
        }
      });
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  _startTunnelProcess() {
    this.tunnelProcess = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${this.port}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.tunnelProcess.on("error", (err) => {
      this.logger.error("☁️  cloudflared tunnel process error:", err.message);
    });

    const handleData = (data) => {
      const text = data.toString();
      const matches = [...text.matchAll(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com/gi)];
      const valid = matches.find((m) => m[1] && m[1].toLowerCase() !== "api");

      if (valid) {
        const nextUrl = valid[0];
        if (this.cachedTunnelUrl === nextUrl) return;
        const changed = this.cachedTunnelUrl && this.cachedTunnelUrl !== nextUrl;
        this.cachedTunnelUrl = nextUrl;
        this.tunnelUrl = nextUrl;
        this.tunnelHealthFailures = 0;

        if (changed) {
          this.logger.log(`☁️  Tunnel URL changed → ${this.tunnelUrl}`);
        } else {
          this.logger.log(`☁️  Tunnel URL → ${this.tunnelUrl}`);
        }
        
        this.onUrlChange(this.tunnelUrl);
      }
    };

    this.tunnelProcess.stdout.on("data", handleData);
    this.tunnelProcess.stderr.on("data", handleData);

    this.tunnelProcess.on("close", (code) => {
      if (this.isStopping) return;

      this.logger.log(`☁️  cloudflared exited (code ${code}), restarting in 5s...`);
      this.onAlert({
        key: `tunnel-exit-${code}`,
        title: "⚠️ Tunnel Restarted",
        description: `cloudflared exited with code ${code}. Restarting in 5 seconds.`,
        color: code === 0 ? 0xf39c12 : 0xe67e22,
        fields: [
          { name: "Issue", value: "Tunnel process exited unexpectedly.", inline: false },
          { name: "Exit Code", value: String(code), inline: true },
          { name: "Last URL", value: this.tunnelUrl || this.cachedTunnelUrl || "unknown", inline: true },
        ],
      });

      this.tunnelUrl = null;
      this.cachedTunnelUrl = null;
      this.tunnelProcess = null;
      this.tunnelHealthFailures = 0;

      this.reconnectTimeout = setTimeout(() => {
        if (!this.isStopping) {
          this._startTunnelProcess();
        }
      }, 5000);
    });
  }
}

module.exports = TunnelManager;
