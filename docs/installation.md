# Installation & Deployment

This document provides in-depth, environment-specific setup instructions and advanced deployment options for TmuxHub.

---

## Prerequisites

Before setting up TmuxHub, ensure your system has:
- [Node.js](https://nodejs.org) 22+
- [tmux](https://github.com/tmux/tmux)
- Optional for remote access: [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)

---

## 🛠️ Manual Installation (Cross-Platform)

### 1) Clone and Install Dependencies

```bash
git clone https://github.com/zr0aces/TmuxHub.git
cd TmuxHub
npm install
```

### 2) Create Configuration Files

```bash
cp .env.example .env
cp config.example.json config.json
```

#### Minimum Required `.env` Config

Set the following variables inside your `.env` file:

```env
PORT=8081
DASHBOARD_PASSWORD=replace-with-a-strong-password
```

> [!NOTE]
> - If `PORT` is not set, the server default is `8081`.
> - The guided setup script prompts with `8080`; update `.env` afterward if you want `8081`.

#### Recommended `config.json` Starter

```json
{
  "basePath": "/absolute/path/for/projects",
  "favorites": [
    "/absolute/path/for/projects/project-a"
  ],
  "defaultCommand": "claude",
  "tunnel": { "enabled": true }
}
```

### 3) Start TmuxHub

```bash
npm start
```

Your dashboard will be available at: **`http://localhost:8081`**

---

## 🍎 macOS Installation

### Option A: Manual Setup
If you want to manually run TmuxHub:

```bash
brew install node tmux
npm install
cp .env.example .env
cp config.example.json config.json
npm start
```

### Option B: Guided Setup + launchd Daemon (Recommended)
TmuxHub provides an automated script to register itself as a background daemon on macOS:

```bash
npm run setup
```

The script checks for system dependencies, prompts to generate `.env` and `config.json` templates, and registers `com.tmuxhub.server` in `launchd`.

#### Service Management Commands

```bash
# Stop the background service
launchctl unload ~/Library/LaunchAgents/com.tmuxhub.server.plist

# Start the background service
launchctl load ~/Library/LaunchAgents/com.tmuxhub.server.plist

# Inspect service logs
cat /tmp/tmuxhub.log
```

---

## 🐧 Ubuntu / Debian Installation

### 1) Install Dependencies

```bash
sudo apt-get update
sudo apt-get install -y nodejs npm tmux
```

### 2) Prepare the Project

```bash
git clone https://github.com/zr0aces/TmuxHub.git
cd TmuxHub
npm install
cp .env.example .env
cp config.example.json config.json
```

### 3) Run Manually (Optional Quick Check)

```bash
npm start
```

### 4) Create a `systemd` Service with `systemctl` (Recommended)

You can run TmuxHub as either:
- a **system service** (`/etc/systemd/system`) for machine-wide startup, or
- a **user service** (`~/.config/systemd/user`) for per-user startup.

Use absolute paths in `WorkingDirectory` and `ExecStart`.

#### Option A — System Service (all users)

1. Create the service file:
   ```bash
   sudo nano /etc/systemd/system/tmuxhub.service
   ```
2. Paste and adjust this example:
   ```ini
   [Unit]
   Description=TmuxHub Dashboard Server
   After=network.target

   [Service]
   Type=simple
   User=YOUR_LINUX_USER
   Group=YOUR_LINUX_USER
   WorkingDirectory=/absolute/path/to/TmuxHub
   ExecStart=/usr/bin/npm start
   Restart=on-failure
   RestartSec=3
   Environment=NODE_ENV=production

   [Install]
   WantedBy=multi-user.target
   ```
3. Reload `systemd` and enable the service:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable tmuxhub
   sudo systemctl start tmuxhub
   ```

#### Option B — User Service (current user only)

1. Create the service directory and file:
   ```bash
   mkdir -p ~/.config/systemd/user
   nano ~/.config/systemd/user/tmuxhub.service
   ```
2. Paste and adjust this example:
   ```ini
   [Unit]
   Description=TmuxHub Dashboard Server (User Service)
   After=default.target

   [Service]
   Type=simple
   WorkingDirectory=/absolute/path/to/TmuxHub
   ExecStart=/usr/bin/npm start
   Restart=on-failure
   RestartSec=3
   Environment=NODE_ENV=production

   [Install]
   WantedBy=default.target
   ```
3. Reload and enable the user service:
   ```bash
   systemctl --user daemon-reload
   systemctl --user enable tmuxhub
   systemctl --user start tmuxhub
   ```

> [!TIP]
> For user services that must start at boot without login, enable lingering:
> `sudo loginctl enable-linger YOUR_LINUX_USER`

### 5) Manage the Service

Use these commands for routine operations.

#### System service commands

```bash
sudo systemctl status tmuxhub
sudo systemctl restart tmuxhub
sudo systemctl stop tmuxhub
sudo systemctl disable tmuxhub
sudo journalctl -u tmuxhub -f
```

#### User service commands

```bash
systemctl --user status tmuxhub
systemctl --user restart tmuxhub
systemctl --user stop tmuxhub
systemctl --user disable tmuxhub
journalctl --user -u tmuxhub -f
```

---

## 🐳 Docker Compose Deployment (Optional)

If you prefer to run TmuxHub in a containerized environment, use the provided Docker Compose configuration:

```bash
cp .env.example .env
cp config.example.json config.json
docker compose up -d
```

By default, Compose publishes the service port on **`8081:8081`** (defined in `docker-compose.yml`).

---

## ☁️ Remote Access & Tunnels (Optional)

### Cloudflare Tunnel Integration

TmuxHub includes out-of-the-box integration with Cloudflare Tunnels (`cloudflared`). If `cloudflared` is available in your system's `PATH`, TmuxHub will automatically spin up a public secure tunnel upon startup.

- **Disable via `.env`**: Set `ENABLE_TUNNEL=0`
- **Disable via `config.json`**:
  ```json
  "tunnel": { "enabled": false }
  ```

#### Finding Your Tunnel URL
You can fetch your active tunnel url from three sources:
1. **Server Logs**: Look for the `☁️ Tunnel URL → https://...` log line on startup.
2. **API Endpoint**: Perform a `GET` request to `/api/tunnel`.
3. **Web Interface**: Auto-broadcasted directly to the web portal via WebSocket.

### Discord Notifications (Optional)

You can receive tunnel status updates on your Discord server by specifying a webhook in `.env`:

```env
DISCORD_WEBHOOK=https://discord.com/api/webhooks/your/webhook-url
```
