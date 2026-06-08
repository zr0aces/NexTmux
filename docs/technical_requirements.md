# NexTmux Technical Requirements

This document outlines the software, hardware, network, and security requirements necessary to successfully run and access the NexTmux workspace manager.

---

## 1. Runtime & Binary Dependencies

To run the NexTmux server, the host system must meet the following software requirements:

* **Node.js**: Version `22.0.0` or higher (utilizes Node's native test runner and modern HTTP/crypto APIs).
* **tmux**: Version `3.0` or higher. The binary must be available in the system's `PATH`.
* **cloudflared** *(Optional)*: Required only if you enable public secure tunnels for WAN/remote access. Must be in the system's `PATH`.

---

## 2. Operating System Compatibility

NexTmux operates on POSIX-compatible host operating systems where native `tmux` is supported:

* **Linux**: Fully supported (tested on Ubuntu 20.04+, Debian, Alpine).
* **macOS**: Fully supported (macOS 12+ recommended; supports macOS `launchd` service registration).
* **Windows**: Supported only via WSL (Windows Subsystem for Linux) with `tmux` installed. Native Windows CMD/PowerShell host environments are **not** supported.

---

## 3. Network & Port Bindings

* **Local Port Binding**: The server requires permission to bind to a local TCP port (default is `8081`, configurable via `.env`).
* **WebSocket Protocol**: The host firewall and any intermediate proxy/load balancer must allow full-duplex WebSocket connections (`ws://` / `wss://`).
* **Outbound Connections**:
  * Outbound HTTP requests to `api.telegram.org` (for Telegram alert integration).
  * Outbound HTTP requests to `discord.com` (for Discord status integration).
  * Outbound TCP connectivity for Cloudflare tunnel client to establish connections with Cloudflare edge servers (`*.trycloudflare.com`).

---

## 4. Client Web Browser Prerequisites

Users accessing the web dashboard require a modern, standards-compliant web browser (Chrome, Safari, Firefox, Edge) supporting the following features:

* **Secure Context**: The dashboard must be accessed via `http://localhost` (or `http://127.0.0.1`) or over an encrypted `https://` connection to enable secure features.
* **WebCrypto API**: Required for the client-side **Remember Password** feature. If WebCrypto is unavailable (e.g., in an insecure context over HTTP WAN), password persistence is disabled.
* **IndexedDB**: Required to securely store client-side cryptographic keys for password decryption.
* **WebSockets**: Standard WebSocket client support.

---

## 5. Security & Permission Requirements

* **Subprocess Execution**: The Node.js process runs as the system user and must have permission to execute child processes (`child_process.execSync`, `spawn`, `execFileSync`) to invoke `tmux` and `git`.
* **File System Access**:
  * **Read & Write Access** is required for the NexTmux root folder and the `state/` directory to maintain `session-state.json`.
  * **Read & Write Access** to any working directory specified when spawning new worker sessions (to run CLI tasks, view git diffs, etc.).
* **Process Lifespan**: Permission to run in the background (via `systemd` or `launchd`) if configured to run as a system daemon.
