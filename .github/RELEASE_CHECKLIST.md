# Unified-MPC Release Checklist

This checklist records Linux release acceptance evidence. No external release-process document is assumed.

**Current version:** `v4.61.0`. Target: Linux Ubuntu, local repository build, private packages.

Run verification from Linux repository root. Every stage must fail fast; `git diff --check` must pass. No packaging, publishing, tag, or release claim without current evidence.

Required commands: `corepack pnpm version:check`, `corepack pnpm typecheck`, `corepack pnpm lint`, `corepack pnpm test`, `corepack pnpm build`, and `cargo test --manifest-path native/linux-host/Cargo.toml --locked`.

Secrets never appear in logs, release evidence, or tracked files. Cloudflare tokens and capability cookies stay operator-local.

## Automated evidence

- Workspace traversal and junction/reparse-point tests pass without broadening the configured path boundary.
- Secret-file policy and log/incident redaction tests pass; release evidence must never contain credentials or tokens.
- AV-sensitive secret-code tests pass: compiled Desktop output and packaged runtime evidence contain no legacy PowerShell secret modules, stale DPAPI imports, `unified-mpc-node.exe`, or `unified-mpc-mcp-stdio.cjs`.
- MCP local HTTP and STDIO transport tests pass, including protocol-only stdout and production handshake coverage.
- External MCP client negotiation is compatibility-driven rather than pinned to unified-mpc's inbound protocol: real stdio fixtures must prove both a legacy/2025-era child and a modern `2026-07-28` child connect through the production External MCP client factory, while unified-mpc's own inbound/local MCP `2026-07-28` contract remains unchanged. Release preparation also performs a local installed-Serena smoke when Serena is present; its absence is not a CI dependency.
- Remote MCP OAuth DCR accepts ChatGPT-style metadata, validates `client_secret_post` credentials at the token endpoint, and returns explicit 4xx errors for malformed or unsupported registration metadata.
- OpenAI Secure Tunnel targets the Desktop loopback HTTP MCP (`sample_mcp_remote_no_auth`) rather than a separate headless stdio runtime, preserving the Desktop profile and Desktop Full Bypass state. Active Project scope/native approval remain enforced when Desktop Full Bypass is OFF.
- Persistent-tunnel acceptance preserves one saved tunnel identity across managed-runtime loss, Desktop/local-MCP rebinding, update/reinstall startup, and detached-runtime handoff; transient retry is capped but unbounded in count, while auth/operator failures do not tight-loop.
- The installed official tunnel client capability probe must show managed `runtimes connect/status/stop` plus health/readiness/control-plane-poll support. Strict zero-downtime may be claimed only if a ready-before-retire overlap primitive is actually proven; otherwise the product must display the capability limitation.
- Linux release packages must use the configured `cloudflared` binary or an explicitly verified operator-provided binary. No silent system fallback in packaged release.
- The 2026-07-28 MCP protocol catalog is compared before/after Desktop MCP listener restart: the complete current default advertised descriptor set and its canonical SHA-256 digest must remain identical, and a production tool call must work on both sides of the restart; tests derive the count from the live registry rather than hard-code it.
- Durable task/session resilience remains independent from one tunnel request; release evidence must not kill a user's live connector merely to manufacture a continuity result.
- Durable Goal Continuation verification covers restart/session resume by stable client identity, single-winner leases with expiry takeover, revision compare-and-swap conflicts, append-only checkpoints, persisted active task IDs, terminal-state closure, corruption fail-closed behavior, and proof that raw lease tokens/sensitive checkpoint text are not persisted.
- Durable continuation acceptance is separate from this Linux package gate. Do not claim scheduled ChatGPT continuity without host evidence.
- Desktop performance regression coverage keeps full dashboard refreshes single-flight, prevents detached Live Logs from starting a redundant dashboard poll, and caches expensive Git/Codex/WSL/capability probes with bounded freshness so idle Desktop operation does not repeatedly spawn heavy discovery commands every second.
- Distribution-aware updater verification proves Installer uses `latest.yml`/Setup while Portable uses `portable.yml`/Portable, with no channel crossover. Portable replacement must wait for exit, replace the exact outer EXE path, keep rollback backup, restart after success, and restore/restart the old EXE on replacement failure.
- Multi-workspace and multi-session Desktop MCP acceptance passes with one listener, parallel A/B flows, scoped ownership, logs, and destructive boundaries.
- Project lifecycle tests verify archive/restore/remove semantics: archived projects leave the active MCP trust boundary, removal preserves project files/history, duplicate paths restore the existing registration, and machine-root workspaces remain protected.
- Tool catalog synchronization passes with 233 total definitions, 226 advertised by default, and all 233 advertised with the six opt-in `codex_*` delegation tools plus `agent_swarm_run` enabled. Hard Settings/runtime eligibility must outrank per-tool overrides: a stale `enabled` preference cannot expose Codex-family tools while Codex Delegation is OFF, and a system-ineligible/setup-required tool must not present a misleading usable enable action. The Tools UI switch reflects `effectiveExposed`, uses a disabled `Setup first / ตั้งค่าก่อน` state when prerequisites are unsatisfied, while ready tools still support persisted disable/re-enable. Tools/Doctor share one cached requirement snapshot, all six readiness states are covered, permission deny projects `blocked`, and selected recheck updates both surfaces. External MCP tools whose server connection and `tools/list` discovery succeed project `ready` transport/catalog status, while child-server permission, profile, cancellation, and dry-run metadata remain explicitly undeclared/unverified instead of inheriting first-party claims.
- Ponytail acceptance remains covered by its own package tests; this checklist records only current Linux release evidence.
- Readiness probes remain side-effect-free: no tool invocation, project-file creation, project command, input control, or Office-document open is used to prove availability. Remediation URLs/commands/settings targets are main-process allowlisted rather than renderer-controlled.
- Remediation acceptance proves Managed Browser can be started directly from Tools/Doctor and PDF Provider setup downloads the pinned Poppler archive, verifies SHA-256 before extraction, installs it under app data, and configures `pdftotext.exe` automatically; manual provider configuration remains supported.
- Issue-first Doctor acceptance covers required `fail` and `unknown` startup blocking, optional failure non-blocking behavior, affected-tool listing, remediation actions, passed-check collapsing, and selected recheck recovery.
- Desktop and direct STDIO Full Bypass toggles are independent, default OFF, appear only in the Full Access (Unrestricted) card, and are effective only with the matching Full profile. Header/audit evidence identifies the active transport mode.
- Full Bypass integration tests prove always-confirm families and inner process/document/Sandbox/upgrade runtimes dispatch without chat/host/profile/command/scope approval, including explicit absolute outside paths, while caller input is not rewritten to `userConfirmed: true`. Durable rolling-goal ownership is not an approval gate: when a live scheduled-goal mutation fence exists, the current `goalLease` is still required and stale/missing proof must fail before handler execution; when no rolling fence exists, ordinary Full Bypass remains lease-free.
- Standard mode remains fail-closed: Safe/Balanced/Custom/Full-OFF profile behavior, independent host approval, Active Project/Strict Roots, protected paths, command policy, and scheduled-continuation fence tests still pass.
- First-run acceptance covers zero-workspace Doctor/Projects access, Add Project retry with preserved input, retryable initial IPC failure, visible partial bootstrap errors, and configured-port unified-mpc identity probing rather than a random free-port check.
- Linux-only release does not enumerate mapped-drive letters.
- Delete/replace/overwrite/reset/restore paths require typed policy classification, exact Active Project scope, explicit confirmation where applicable, and recovery evidence before mutation.
- With Full Bypass OFF, exact `delete_file` is the only mutation eligible for scoped auto-approval; protected critical paths, workspace roots, non-empty directories, unsafe patterns, outside paths, and reparse escapes remain blocked from auto-approval. Full Bypass ON supersedes unified-mpc approval/scope policy for an exact target but does not remove root/non-empty-directory validation or provide Recovery Trash outside a workspace.
- Approval-required mutations use an independent host exact-action approval boundary. Desktop approval is cancel-first; standalone/headless runtimes without a trusted host approval provider fail closed before dispatch.
- Arbitrary approved commands and project-owned scripts are opaque execution, not an operating-system sandbox, and are not automatically recoverable through Recovery Trash.
- Recovery Center verification covers deleted items, binary pre-replacement backups, checkpoints, rollback IDs, and the displayed local Recovery Trash path.
- `cloudflared` tunnel smoke verifies real URL, MCP identity health, measured latency, and graceful stop.
- MCP public hostname/origin allowlist tests prove exact allowlist behavior; wildcard access is forbidden.
- `unified-mpc-mcp-http` starts real MCP Streamable HTTP runtime against `unified-mpc.sqlite`.
- No Windows/macOS packaged-app smoke is in Linux-only release scope.

## Manual clean-machine evidence

On clean Linux Ubuntu, start `unified-mpc-mcp-http`, verify `/_unified-mpc/identity`, start web dashboard, start gateway, copy `mcpUrl` into ChatGPT Web connector, perform one harmless tool call, then stop all processes. Record OS, commit, URL hostname only, and pass/fail. Do not record tokens.

Run one low-impact real Codex discovery/delegation check only in a disposable Git fixture. Do not automate provider quota consumption and do not read Codex credential files.

If a required Linux runtime is missing, preserve exact failure and stop release. Do not weaken security or substitute unverified binaries.
