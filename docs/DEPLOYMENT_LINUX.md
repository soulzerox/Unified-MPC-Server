# Ubuntu Linux Deployment & systemd User Services

Unified-MPC-Server runs natively on modern Ubuntu/Debian Linux. The recommended persistent deployment uses two systemd **user** services: the Streamable HTTP MCP runtime on loopback port `18765`, and the Local Web Control Plane on loopback port `3000`.

## 1. Requirements

- Ubuntu 22.04 LTS, 24.04 LTS, or a modern Debian-based distribution.
- Node.js `>=22.0.0`.
- Corepack + pnpm `>=10`.
- `systemd` user services.
- `curl` for the MCP HTTP readiness probe.
- `cloudflared` on the Web service `PATH` when the ChatGPT bridge is enabled. `~/.local/bin` is included by the supplied unit.
- A working Linux Secret Service when Cloudflare credentials/tunnel tokens are persisted.

Persistent application data follows XDG directories:

| Purpose | Default path |
|---|---|
| Configuration | `~/.config/unified-mpc/` |
| Persistent data | `~/.local/share/unified-mpc/` |
| Logs/state | `~/.local/state/unified-mpc/` |
| Cache | `~/.cache/unified-mpc/` |

## 2. Build and verify

From the repository root:

```bash
corepack enable
pnpm install
pnpm build
pnpm cli doctor
```

The systemd units execute the built files under `apps/cli/dist`, so rebuild before restarting the services after a source update.

## 3. Install the user services

The repository contains three unit files:

- `scripts/unified-mpc-mcp-http.service` — MCP HTTP runtime, `127.0.0.1:18765`.
- `scripts/unified-mpc-web.service` — Web Control Plane, `127.0.0.1:3000`; it requires the MCP HTTP unit and starts only after the MCP identity endpoint passes its readiness probe.
- `scripts/unified-mpc.service` — compatibility aggregate that starts/stops both child units together.

Copy the units and environment template:

```bash
mkdir -p ~/.config/systemd/user ~/.config/unified-mpc
cp scripts/unified-mpc-mcp-http.service ~/.config/systemd/user/
cp scripts/unified-mpc-web.service ~/.config/systemd/user/
cp scripts/unified-mpc.service ~/.config/systemd/user/
cp scripts/validate-runtime-root.sh ~/.config/unified-mpc/validate-runtime-root.sh
cp scripts/promote-runtime.sh ~/.config/unified-mpc/promote-runtime.sh
cp scripts/unified-mpc.service.env.example ~/.config/unified-mpc/service.env
```

Edit `~/.config/unified-mpc/service.env` and set **absolute paths**:

```ini
UNIFIED_MPC_ROOT=/home/you/.local/share/unified-mpc/runtime/current
UNIFIED_MPC_WORKSPACE=/absolute/path/to/your/project
PATH=/home/you/.local/bin:/usr/local/bin:/usr/bin:/bin
```

`EnvironmentFile` values are literal: do not use `~` or `$HOME`. If Node comes from nvm/asdf/mise, prepend its exact `bin` directory to `PATH`. Keep `~/.local/bin` (expanded to the real home path in `service.env`) when `cloudflared` is installed there.

`UNIFIED_MPC_WORKSPACE` must be a real project directory, not `/`, `/mnt`, or another filesystem mount root.

### Runtime-root safety

`UNIFIED_MPC_ROOT` is the **production runtime identity**, not a Goal Workspace. It must point to either the durable canonical checkout or a stable promoted release directory whose lifecycle is independent of issue/goal cleanup. Never point it at:

- `.unified-mpc/worktrees/*` or another linked Git worktree;
- Goal/delegated/inspection/temporary workspaces;
- a symlink that resolves to one of those locations.

The supplied units run `~/.config/unified-mpc/validate-runtime-root.sh` with `/usr/bin/bash` before Node starts. The validator lives outside `UNIFIED_MPC_ROOT`, so a missing or cleaned runtime tree can still fail with an actionable `RUNTIME_ROOT_INVALID`, `RUNTIME_ROOT_DISPOSABLE`, or `RUNTIME_ARTIFACT_MISSING` diagnostic instead of entering only a curl/restart failure loop.

The preflight validates the **final systemd environment**. Local drop-ins can override values after the checked-in unit, so inspect the effective configuration whenever a runtime root changes:

```bash
systemctl --user cat unified-mpc-mcp-http.service
systemctl --user cat unified-mpc-web.service
```

Remove stale drop-ins or environment files that redirect `UNIFIED_MPC_ROOT` to a completed/cleanup-managed worktree. In particular, a legacy `~/.config/unified-mpc/runtime-root.env` must not be used to make a disposable build/Goal worktree the durable production root.

### Atomic active-runtime promotion and rollback

For production, point `UNIFIED_MPC_ROOT` at one stable pointer only:

```text
~/.local/share/unified-mpc/runtime/current
```

A deployment pipeline may build in an isolated Goal/build worktree, but it must first materialize a **complete runnable release** under the deployment-owned release directory:

```text
~/.local/share/unified-mpc/runtime/
├── releases/
│   ├── <deployment-a>/
│   └── <deployment-b>/
├── current -> releases/<active-deployment>
└── last-known-good -> releases/<last-healthy-deployment>
```

The release directory must already contain the runtime entrypoints, package/runtime dependencies required by those entrypoints, and `apps/cli/dist/build-provenance.json`. Do **not** pass a Goal/build worktree directly to the promoter and do not make a release symlink resolve back into a worktree.

After installing the user units and running `systemctl --user daemon-reload`, promote a pre-materialized release with:

```bash
runtime_dir="$HOME/.local/share/unified-mpc/runtime"
release="$runtime_dir/releases/20260922-<build-sha>"
deployment_id="20260922-<build-sha>"

bash ~/.config/unified-mpc/promote-runtime.sh "$release" "$deployment_id"
```

The promoter:

1. accepts only releases physically resolved under `runtime/releases/`;
2. runs the same MCP/Web runtime-root preflight used by systemd;
3. rejects malformed or dirty build provenance;
4. acquires a non-blocking promotion lock;
5. persists the candidate, previous active root, rollback target and build commit before activation;
6. atomically replaces the `current` symlink;
7. restarts `unified-mpc.service` and checks `/_unified-mpc/identity`;
8. requires the running `buildCommit` to equal the promoted artifact;
9. advances `last-known-good` only after the new runtime is healthy;
10. atomically restores the previous known-good release and re-verifies it when activation fails.

Deployment evidence is stored under `~/.local/state/unified-mpc/deployments/<deployment-id>/` with bounded status/health/rollback fields. Deployment IDs are immutable; reusing an existing ID fails closed.

This promotion step intentionally activates an **already materialized runnable release**. Copy/package/materialization from a source worktree is a separate deployment step and must preserve artifact provenance; source cleanup must not change anything inside the promoted release.

Validate the checked-in unit syntax before installation or after edits:

```bash
systemd-analyze verify \
  scripts/unified-mpc.service \
  scripts/unified-mpc-mcp-http.service \
  scripts/unified-mpc-web.service
```

## 4. Enable boot persistence

Enable lingering once so the user manager can start at boot without an interactive login:

```bash
loginctl enable-linger "$USER"
loginctl show-user "$USER" | grep Linger
# Linger=yes
```

Then reload and enable the aggregate service:

```bash
systemctl --user daemon-reload
systemctl --user enable --now unified-mpc.service
systemctl --user status unified-mpc-mcp-http.service unified-mpc-web.service
```

The MCP unit waits for `http://127.0.0.1:18765/_unified-mpc/identity` before systemd considers its startup sequence complete. The Web unit is ordered after it, so the dashboard does not race a not-yet-listening MCP origin during normal boot.

The units intentionally use systemd's default control-group kill behavior rather than `KillMode=process`, so spawned descendants are not orphaned when a service is stopped.

## 5. Gateway desired state and reboot behavior

Gateway lifecycle intent is persistent:

- A successful **Start Gateway** or successful **Validate, Configure & Start** stores desired state `RUNNING`.
- An explicit **Stop Gateway** stores desired state `STOPPED`.
- On Web service restart/reboot, persisted configuration is applied first. `RUNNING` is automatically reconciled back to a healthy bridge with bounded retry/backoff; `STOPPED` remains stopped.
- Legacy installations that have persisted tunnel configuration but no desired-state key are treated as `RUNNING` once, then migrated by persisting `RUNNING` after successful recovery.

You therefore do **not** need to click Start Gateway after every reboot. An explicit Stop remains authoritative until the user starts/reconfigures the gateway again.

If the Linux Secret Service is temporarily unavailable during early boot, the Web service may fail and systemd will retry it (`Restart=on-failure`). Unattended Cloudflare recovery still requires the stored secret service to become accessible.

## 6. Operations

```bash
# Overall aggregate
systemctl --user status unified-mpc.service
systemctl --user restart unified-mpc.service
systemctl --user stop unified-mpc.service

# Individual services
systemctl --user status unified-mpc-mcp-http.service
systemctl --user status unified-mpc-web.service

# Logs
journalctl --user -u unified-mpc-mcp-http.service -f
journalctl --user -u unified-mpc-web.service -f
```

Because both child units declare `PartOf=unified-mpc.service`, stopping or restarting the aggregate propagates to the MCP and Web services.

## 7. Security and network notes

1. Both servers bind to loopback. Do not expose ports `18765` or `3000` directly on public interfaces.
2. The Cloudflare gateway is the intended remote bridge and keeps the local MCP origin on loopback.
3. The supplied units use `NoNewPrivileges=true`, `PrivateTmp=true`, and `ProtectSystem=full`. They deliberately do **not** make the user's home read-only because MCP coding/file tools must be able to mutate registered workspaces; application-level workspace containment and mutation policy remain the authorization boundary.
4. Remote Skill/MCP repository installation accepts HTTPS Git sources without embedded credentials. Skill repositories reject symlinks and discard Git metadata; MCP repository installation does not run package install scripts and fails closed for packages that still require runtime dependency installation.
