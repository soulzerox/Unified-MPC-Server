# Ubuntu Linux Deployment & systemd User Services

Unified-MPC-Server runs natively on modern Ubuntu/Debian Linux. The recommended persistent deployment uses two systemd **user** services: the Streamable HTTP MCP runtime on loopback port `18765`, and the Local Web Control Plane on loopback port `3000`.

## 1. Requirements

- Ubuntu 22.04 LTS, 24.04 LTS, or a modern Debian-based distribution.
- Node.js `>=22.0.0`.
- Corepack + pnpm `>=10`.
- `systemd` user services.
- `curl` for the MCP HTTP readiness probe.
- `flock` (util-linux) for non-overlapping runtime promotion.
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
pnpm install --frozen-lockfile --prefer-offline
pnpm build
pnpm cli doctor
```

The build still produces the runtime files under `apps/cli/dist`. For production, do not make a source checkout/worktree update become live merely by restarting systemd: build and verify first, materialize a complete runnable release under the deployment-owned runtime directory, then activate it with the promotion flow below.

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
cp scripts/launch-runtime.sh ~/.config/unified-mpc/launch-runtime.sh
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

`UNIFIED_MPC_ROOT` is the **production runtime identity**, not a Goal Workspace. The recommended production value is the stable `runtime/current` pointer. The validator also permits a durable canonical checkout for controlled recovery/development use, but its lifecycle must remain independent of issue/goal cleanup. Never point it at:

- `.unified-mpc/worktrees/*` or another linked Git worktree;
- Goal/delegated/inspection/temporary workspaces;
- a symlink that resolves to one of those locations.

The supplied units launch through the stable `~/.config/unified-mpc/launch-runtime.sh` reconciler, which lives outside `UNIFIED_MPC_ROOT`. Before Node starts it validates a **common MCP + Web runtime** with `validate-runtime-root.sh`.

The configured `UNIFIED_MPC_ROOT` remains authoritative when it is valid. If a late systemd drop-in or legacy environment file supplies a missing, disposable, or incomplete root, the launcher conservatively tries the deployment-owned pointers in this order:

1. `runtime/current`;
2. `runtime/last-known-good`.

Fallback pointers are accepted only when they resolve under the deployment-owned `runtime/releases/*` directory and pass both MCP and Web runtime validation. The child process receives the reconciled path through its own exported `UNIFIED_MPC_ROOT`, so a stale override cannot redirect execution back into a disposable Goal/build worktree.

A recovery emits an auditable `RUNTIME_ROOT_RECOVERED` diagnostic naming the selected pointer and resolved runtime. If no safe fallback exists, the launcher emits the underlying `RUNTIME_ROOT_*` diagnostics plus `RUNTIME_RECOVERY_UNAVAILABLE` and exits with status 78. The units set `RestartPreventExitStatus=78`, preventing an unrecoverable configuration from looping forever while preserving normal `Restart=on-failure` behavior for transient runtime failures.

The launcher does **not** rewrite `service.env`, legacy drop-ins, or deployment pointers. Recovery is therefore idempotent and conservative; remove the stale configuration after inspecting the effective unit:

```bash
systemctl --user cat unified-mpc-mcp-http.service
systemctl --user cat unified-mpc-web.service
```

In particular, a legacy `~/.config/unified-mpc/runtime-root.env` must not be used to make a disposable build/Goal worktree the durable production root.

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

Materialize the already-built clean worktree into a self-contained release first. The materializer uses the existing pnpm store with `--prefer-offline` and pnpm 10's portable workspace deploy mode; it writes through a staging directory, rejects any release symlink that resolves back outside the release, and publishes only after runtime-root validation succeeds:

```bash
runtime_dir="$HOME/.local/share/unified-mpc/runtime"
deployment_id="20260922-$(git rev-parse --short=12 HEAD)"

UNIFIED_MPC_RUNTIME_DIR="$runtime_dir" \
  pnpm release:materialize -- "$deployment_id"

release="$runtime_dir/releases/$deployment_id"
```

The source/build worktree may be removed **only after materialization returns successfully**: runtime package dependencies are localized under `$release/apps/cli/node_modules`, while build provenance remains at `$release/apps/cli/dist/build-provenance.json`.

While a linked Goal/build worktree is being materialized, the materializer holds a native Git worktree lock and publishes an active source reference under `~/.local/state/unified-mpc/materializations/<deployment-id>/`. The #80 cleanup fence consumes that `materialization_source` reference, so dry-run/destructive cleanup explains the blocker before removal; the Git lock is the final TOCTOU defense if cleanup and materialization begin concurrently. Normal completion terminalizes the record as `published`; normal failure records `failed` and unlocks the source.

An abrupt process/host crash may intentionally leave a `materializing` record and a locked linked worktree. That state is fail-closed: do not force-remove it. Inspect the materialization record, staging/release state, and `git worktree list --porcelain`; only after confirming no materializer can still be using the source should an operator explicitly reconcile/unlock the stale worktree.

After installing the user units and running `systemctl --user daemon-reload`, activate that immutable release:

```bash
bash ~/.config/unified-mpc/promote-runtime.sh "$release" "$deployment_id"
```

The promoter:

1. accepts only releases physically resolved under `runtime/releases/`;
2. runs the same MCP/Web runtime-root preflight used by systemd;
3. rejects malformed or dirty build provenance;
4. acquires a non-blocking promotion lock;
5. persists the candidate, previous active root, rollback target and build commit before activation;
6. atomically replaces the `current` symlink;
7. restarts `unified-mpc.service` and checks both MCP `/_unified-mpc/identity` and Web `/api/status`;
8. requires the MCP identity and Web-projected MCP `buildCommit` to equal the promoted artifact;
9. advances `last-known-good` only after both local services are healthy;
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
