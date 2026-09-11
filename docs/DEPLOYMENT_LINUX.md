# Ubuntu Linux Deployment & Systemd Daemonization

Unified-MPC-Server is built from the ground up for 100% Linux Ubuntu environments (Ubuntu 22.04 LTS & 24.04 LTS). It has zero Windows dependencies, zero Electron overhead, and adheres strictly to POSIX and Linux Standards Base (LSB) conventions.

---

## 1. System Requirements & Environment

### Operating System & Dependencies
- **OS**: Ubuntu Linux 22.04 LTS, 24.04 LTS, or Debian-based modern Linux distribution.
- **Node.js**: `v20.x` or `v22.x` (LTS releases recommended).
- **Package Manager**: `pnpm` (managed via Corepack).
- **Init System**: `systemd` (with user session management enabled).

### XDG Base Directory Layout
All persistent data, logs, and configurations reside under standard Linux XDG directories in the user's home:

| Purpose | Default Path | Environment Variable Override |
|---|---|---|
| **Configuration** | `~/.config/unified-mpc/` | `$XDG_CONFIG_HOME/unified-mpc/` |
| **Persistent Data** | `~/.local/share/unified-mpc/` | `$XDG_DATA_HOME/unified-mpc/` |
| **Logs & State** | `~/.local/state/unified-mpc/logs/` | `$XDG_STATE_HOME/unified-mpc/logs/` |
| **Cache** | `~/.cache/unified-mpc/` | `$XDG_CACHE_HOME/unified-mpc/` |

---

## 2. Monorepo Build & Verification

Before running Unified-MPC as a system daemon, build the monorepo packages and verify health:

```bash
# Enable Corepack and activate pnpm
corepack enable
corepack prepare pnpm@latest --activate

# Install dependencies
pnpm install

# Build all 21 packages
pnpm build

# Run health checks
pnpm cli doctor
```

---

## 3. Systemd User Service Setup

Running Unified-MPC-Server as a **systemd user service** allows it to start automatically on user login, restart on unexpected termination, and output logs to `journald` without requiring `sudo` privileges.

### Step 1: Create the Systemd Unit File

Create the user systemd directory if it does not already exist:

```bash
mkdir -p ~/.config/systemd/user
```

Install the unit file to `~/.config/systemd/user/unified-mpc.service`:

```ini
[Unit]
Description=Unified-MPC-Server Daemon & Web Control Plane
Documentation=https://github.com/soulzerox/Unified-MPC-Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/mnt/workspace_data/Unified MCP Server
ExecStart=/usr/bin/node /mnt/workspace_data/Unified MCP Server/apps/cli/dist/index.js web --port 18765
Restart=always
RestartSec=5
KillMode=process
Environment=NODE_ENV=production
Environment=PORT=18765

# Security hardening
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=/mnt/workspace_data/Unified MCP Server /home/qwerty/.local/share/unified-mpc /home/qwerty/.config/unified-mpc /home/qwerty/.local/state/unified-mpc

[Install]
WantedBy=default.target
```

*(Note: Adjust paths to match your local installation directory and user profile)*

---

### Step 2: Enable Persistent Lingering

By default, user services terminate when the user logs out of their SSH or desktop session. To allow the service to run persistently across reboots:

```bash
loginctl enable-linger $USER
```

Verify linger status:

```bash
loginctl show-user $USER | grep Linger
# Expected output: Linger=yes
```

---

### Step 3: Enable and Start the Service

Reload systemd daemon, enable the service to start automatically on boot, and start it immediately:

```bash
# Reload user units
systemctl --user daemon-reload

# Enable and start
systemctl --user enable --now unified-mpc.service

# Check service status
systemctl --user status unified-mpc.service
```

---

## 4. Operational Monitoring & Maintenance

### Inspecting Service Logs
View live, streaming logs via `journalctl`:

```bash
# Stream real-time logs
journalctl --user -u unified-mpc.service -f

# View the last 100 log lines
journalctl --user -u unified-mpc.service -n 100 --no-pager
```

### Managing Service Lifecycle
```bash
# Restart the daemon
systemctl --user restart unified-mpc.service

# Stop the daemon
systemctl --user stop unified-mpc.service

# Disable auto-start
systemctl --user disable unified-mpc.service
```

---

## 5. Security & Network Hardening

1. **Loopback Binding**: The Web Control Plane strictly binds to `127.0.0.1`. Never bind `0.0.0.0` directly on public or shared network interfaces.
2. **Reverse Proxy (Optional)**: If access from other machines on a private LAN is required, front the service with Nginx or Caddy utilizing Mutual TLS (mTLS) or HTTP Basic Authentication.
3. **Firewall (UFW)**:
   ```bash
   # Ensure no external ingress to port 18765
   sudo ufw status verbose
   ```

