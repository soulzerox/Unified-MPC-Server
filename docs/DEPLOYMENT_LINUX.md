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

Install the units and stable helper scripts with the boot-persistence helper:

```bash
bash scripts/install-user-services.sh
```

On first run, if `~/.config/unified-mpc/service.env` does not exist, the helper installs the template and exits with `CONFIG_REQUIRED` before enabling the service. Edit the generated file, then run the helper again. The second run verifies or enables systemd user linger, reloads the user manager, enables and starts `unified-mpc.service`, and confirms both MCP HTTP and Web child services are active. If linger cannot be enabled, it fails with `BOOT_PERSISTENCE_UNAVAILABLE` instead of claiming reboot persistence.

Edit `~/.config/unified-mpc/service.env` and set **absolute paths**:

```ini
UNIFIED_MPC_ROOT=/home/you/.local/share/unified-mpc/runtime/current
UNIFIED_MPC_WORKSPACE=/absolute/path/to/your/project
PATH=/home/you/.local/bin:/usr/local/bin:/usr/bin:/bin
```

`EnvironmentFile` values are literal: do not use `~` or `$HOME`. If Node comes from nvm/asdf/mise, prepend its exact `bin` directory to `PATH`. Keep `~/.local/bin` (expanded to the real home path in `service.env`) when `cloudflared` is installed there.

`UNIFIED_MPC_WORKSPACE` must be a real project directory, not `/`, `/mnt`, or another filesystem mount root.

### Thai-RAG single-host mode (#407)

In the standard single-host deployment, the MCP HTTP runtime is the designated
Thai-RAG provider host: it owns `provider.lock` and runs the Python worker. The
shipped stdio entrypoint (`mcp-stdio`) follows that host by default and never
elects itself, so a client process cannot take ownership away from the
long-lived host during a restart or first boot.

If you run a standalone stdio server without the HTTP runtime, set
`UNIFIED_THAI_RAG_FORWARD_ONLY=0` in that process environment to restore local
election. `1`/`true`/`yes`/`on` forces follow mode for any runtime.

### Thai-RAG index-status deadline (#407)

A worker that accepts the socket but stops answering `index_status` must not
hold the read gate open. Each status poll has its own bounded call timeout
instead of inheriting the one-hour index-session budget:

```sh
# Per-poll deadline in milliseconds (1000-3600000, default 30000).
UNIFIED_MPC_THAI_RAG_INDEX_STATUS_TIMEOUT_MS=30000
# Consecutive timed-out polls before the mirrored job fails (1-600, default 30).
UNIFIED_MPC_THAI_RAG_INDEX_STATUS_TIMEOUT_POLLS=30
```

The worst-case gate hold is roughly `polls * timeout` plus backoff (15 minutes
with the defaults). When it expires the durable job is marked `failed` with the
machine-readable `index-status-unreachable` reason, the admission gate is
released, and later reads re-admit against the active generation without a
runtime restart. Lower the values only if your provider answers status reads
quickly; a stale index is safer than a gate that never clears.

### Thai-RAG code-index vectors (#445)

Code indexing is FTS5-first by policy (#463): Unified asks the provider to index
code lexically only, the provider publishes `semantic: lexical_only`, and the
pre-edit gate accepts that as current. This is the supported default on every
host, including CPU-only ones.

If you deliberately want a semantic code baseline on this deployment, opt in
explicitly:

```sh
# 1/true/yes/on requests code embeddings; anything else stays lexical-only.
UNIFIED_MPC_THAI_RAG_CODE_INDEX_VECTORS=0
```

This is a deployment decision, not a tuning flag. Enabling it starts a full
semantic pass over the workspace, which on a 2-core CPU-only host takes roughly
13-20 hours and saturates the machine for most of that time. Interrupted passes
resume from `embedding_artifacts`, so a reap or restart costs the remaining
chunks rather than the whole rebuild. Chunker or embedding-profile changes
still invalidate the cache and force a cold pass.

Leave it at `0` unless retrieval quality, not write authorization, is the
problem you are solving; the gate opens either way.

### Heavy job queue (#145)

Declared heavy work runs through one durable queue shared by the MCP HTTP and
stdio runtimes. The default constrained profile admits **one heavy job at a
time**; a second declaration waits instead of failing or running beside it.

Heavy classes are `verification_heavy` (full build/test/lint/typecheck
verification) and `rag_indexing` (large index/embedding batches). Callers opt in
explicitly, with no command-name heuristics:

```jsonc
{
  "operation": "run",
  "executable": "pnpm",
  "arguments": ["-r", "test"],
  "execution": "background",
  "admission_class": "verification_heavy"
}
```

A declared run writes its durable task as `waiting_resource` first and starts
only when the admission controller frees a heavy slot; `shell` `status` / `wait`
then show an `admission` block with class, cost, state, position and waited
time. `timeout_seconds` starts counting at launch, so queue residence does not
consume the caller's budget.

The global bound (16 waiting declared runs) is not the only one: shell admission
also refuses to queue more than `UNIFIED_MPC_HEAVY_MAX_QUEUED_PER_WORKSPACE`
heavy rows for one workspace (default 16, never above the global bound). With the
default equal to the global bound the cap only bites after an operator lowers it;
once lowered, a single project can no longer fill the queue and starve another
that has eligible work. The count is every queued row of that workspace, not only
shell declarations: pre-edit work shares the durable queue, so an already queued
pre-edit row consumes part of the workspace's budget, even though pre-edit intake
itself is bounded only by its own queue limit. A run over that bound is refused
before its task record is written and reaches the caller as the same
`RESOURCE_PRESSURE` refusal described below; identical work that is already
queued still coalesces instead of being rejected.

Operator behavior to expect:

- the waiter list is bounded (16 queued shell declarations); overflow returns
  `RESOURCE_PRESSURE` before a task record exists, so a refused run never holds
  a slot;
- cancel while queued removes the queue row and spawns nothing;
- queued work survives an MCP restart: the next runtime adopts the existing
  durable row and starts it on admission, keeping its queue position;
- a `waiting_resource` task older than the one-hour queue retention fails with
  `expired before a runtime re-attached it`, and one whose queue row was retired
  fails with `interrupted before admission` instead of silently starting a new
  generation;
- `termination_unverified` keeps the heavy slot until worker-identity
  reconciliation proves the process is gone, so a possibly-live build never
  overlaps new heavy work.

Use `heavy_job_queue_status` to inspect queue depth, queued rows per workspace
with the configured per-workspace bound, the running job, positions, wait/run
durations, heartbeats, active heavy cost and memory pressure without admitting
new work. When the durable store keeps history, the response also
carries `outcomes` — `completed`, `failed`, `interrupted`, `cancelled`,
`superseded` and `total` for jobs that finished in the last **24 hours**
(`windowMs`, `since`). It counts distinct operation identities, so a re-claimed
job reports only its latest outcome; use it to tell a starved queue (nothing
finishing) from a failing one. `status` / `list` on `shell` show the same
parking state per task.

Cross-project fairness (#145) shapes which queued job is tried next:

- when several workspaces have queued heavy work, the queue alternates one
  candidate per workspace per pass instead of draining one project's burst.
  The least-recently-served workspace goes first, and a workspace that just
  started a job yields its next turn to the others;
- blocking work always comes first, including rotation inside that tier; a job
  that has waited at least **30 minutes** (`agingMs`) is tried ahead of the
  workspace rotation but never ahead of blocking work and never past a global
  admission denial. Aging is a starvation ceiling, not a latency promise;
- fairness history is process-local and **restart clears it**: the oldest
  queued job goes first and rotation resumes. Durable positions are never
  rewritten, so the stored position remains the audit order and restart
  fallback;
- when the serving runtime owns a shell admission queue,
  `heavy_job_queue_status` returns `fairness.scope: "runtime-local"` with
  `agingMs`, and adds `effectiveRank` (0 = next tried) and `aged` to queued
  entries. The projection is computed from the same state as the drain, so it
  cannot disagree with the order actually tried. Runtimes without a shell
  admission queue omit these fields.

#### Measured heavy headroom

The base cap stays one heavy slot. Extra heavy slots come from **measured
memory and CPU headroom**, never from total RAM:

- an extra slot requires normal pressure and, after a reserve, enough
  `availableMemoryBytes` for one job estimate;
- the 1-minute load average must also stay at or below a per-core threshold, so
  a CPU-saturated host does not start a second heavy job just because RAM is
  free;
- the configured cap remains the floor and hard bound; the default policy adds
  at most one extra slot;
- class, workspace, session and global weighted-cost ceilings still apply. With
  the default 8-cost `verification_heavy` class, the extra slot pairs a
  verification job with an indexing job; two verification jobs still do not
  overlap unless their class ceiling is raised;
- elevated or critical pressure removes the extra slots immediately without
  revoking running leases; a missing or malformed memory or CPU sample fails
  closed to the base cap.

The policy is process-wide and read once at runtime startup:

| Variable | Default | Meaning |
| --- | --- | --- |
| `UNIFIED_MPC_HEAVY_MAX_EXTRA_JOBS` | `1` | Extra heavy slots above the base cap; `0` disables measured widening. |
| `UNIFIED_MPC_HEAVY_JOB_MEMORY_BYTES` | `4294967296` (4 GiB) | Memory reserved per extra heavy job. |
| `UNIFIED_MPC_HEAVY_HEADROOM_RESERVE_BYTES` | `2147483648` (2 GiB) | Memory kept free for the OS/runtime before extra slots count. |
| `UNIFIED_MPC_HEAVY_MAX_LOAD_PER_CORE` | `0.5` | Highest 1-minute load average per core for extra slots; `0` disables the CPU gate. |
| `UNIFIED_MPC_HEAVY_MAX_QUEUED_PER_WORKSPACE` | `16` | Queued heavy rows one workspace may hold before shell admission refuses more; queued pre-edit rows count too. Must be an integer between 1 and the global bound of 16. |

Invalid values fail runtime startup with the variable name. An 8 GiB host with
the defaults normally keeps one heavy slot. `heavy_job_queue_status` reports
both the configured `maxHeavyOperations` and the measured
`effectiveMaxHeavyOperations` in its `admission` block, plus the memory
(`pressure`) and CPU (`cpu`) samples that produced the decision.

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

A recovery emits an auditable `RUNTIME_ROOT_RECOVERED` diagnostic naming the selected pointer and resolved runtime. If no safe fallback exists, the launcher emits the underlying `RUNTIME_ROOT_*` diagnostics plus `RUNTIME_RECOVERY_UNAVAILABLE` and exits with status 78. Both units set `RestartPreventExitStatus=78`, preventing an unrecoverable configuration from looping forever. The MCP HTTP unit uses `Restart=on-failure`; the Web unit uses `Restart=always` so watchdog-triggered or clean transient exits recover automatically while exit 78 remains restart-prevented.

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

When the promoter is invoked from a process that is itself inside the `unified-mpc.service`, `unified-mpc-mcp-http.service`, or `unified-mpc-web.service` cgroup, it delegates the real promotion transaction to an independent transient `systemd --user` service **before** acquiring the promotion lock or creating deployment state. This keeps the promotion owner alive while the aggregate runtime restarts its child services. The delegated transaction owns lock/state/health/rollback to completion; if delegation cannot escape the runtime service cgroup, promotion fails closed instead of recursing. Direct operator invocations outside the runtime service cgroups keep the original synchronous path.

This promotion step intentionally activates an **already materialized runnable release**. Copy/package/materialization from a source worktree is a separate deployment step and must preserve artifact provenance; source cleanup must not change anything inside the promoted release.

Validate the checked-in unit syntax before installation or after edits:

```bash
systemd-analyze verify \
  scripts/unified-mpc.service \
  scripts/unified-mpc-mcp-http.service \
  scripts/unified-mpc-web.service
```

## 4. Enable boot persistence

The installation helper enforces boot persistence after `service.env` is configured:

```bash
bash scripts/install-user-services.sh
systemctl --user status unified-mpc.service unified-mpc-mcp-http.service unified-mpc-web.service
loginctl show-user "$USER" -p Linger
```

A successful run prints `BOOT_PERSISTENCE_READY`. This means `Linger=yes`, the aggregate service is enabled for the user manager, and both child services are active. If your host policy prevents `loginctl enable-linger`, the helper exits non-zero with `BOOT_PERSISTENCE_UNAVAILABLE`; resolve that host policy before relying on automatic startup after reboot.

The MCP unit waits for `http://127.0.0.1:18765/_unified-mpc/identity` before systemd considers its startup sequence complete. The Web unit is ordered after it, so the dashboard does not race a not-yet-listening MCP origin during normal boot.

The units intentionally use systemd's default control-group kill behavior rather than `KillMode=process`, so spawned descendants are not orphaned when a service is stopped.

## 5. Gateway desired state and reboot behavior

Gateway lifecycle intent is persistent:

- A successful **Start Gateway** or successful **Validate, Configure & Start** stores desired state `RUNNING`.
- An explicit **Stop Gateway** stores desired state `STOPPED`.
- On Web service restart/reboot, persisted configuration is applied first. Once persisted configuration and credentials can be read, `RUNNING` is automatically reconciled back to a healthy bridge with bounded retry/backoff; `STOPPED` remains stopped.
- Legacy installations that have persisted tunnel configuration but no desired-state key are treated as `RUNNING` once, then migrated by persisting `RUNNING` after successful recovery.

You therefore do **not** need to click Start Gateway after every reboot. An explicit Stop remains authoritative until the user starts/reconfigures the gateway again.

If the Linux Secret Service is temporarily unavailable during early boot, the Web service remains locally reachable while persisted Gateway recovery reports a degraded state. The Web unit uses `Restart=always` plus a local-only readiness watchdog; downstream MCP/Cloudflare degradation alone does not fail that local readiness check. Exit status 78 remains restart-prevented for unrecoverable runtime-root configuration. Cloudflare reconciliation can resume once the stored secret service is accessible and the persisted restore is retriggered, for example by restarting the Web service.

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
3. The supplied units use `NoNewPrivileges=true`, `PrivateTmp=true`, and `ProtectSystem=full`. They deliberately do **not** make the user's home read-only because MCP coding/file tools must be able to mutate registered workspaces; application-level workspace containment and mutation policy remain the authorization boundary. The runtime launcher also pins `TMPDIR` and `NODE_COMPILE_CACHE` to a mode-0700 per-service directory under `XDG_RUNTIME_DIR` (falling back to the user cache directory outside systemd), probes that directory before Node starts, and fails with status 78 if it is unsafe or unwritable. This keeps TypeScript/Vitest/Node temp work independent from a stale `PrivateTmp` backing mount while preserving `PrivateTmp=true` as defense in depth.
4. Remote Skill/MCP repository installation accepts HTTPS Git sources without embedded credentials. Skill repositories reject symlinks and discard Git metadata; MCP repository installation does not run package install scripts and fails closed for packages that still require runtime dependency installation.
