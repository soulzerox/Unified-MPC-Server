# Audit Remediation Record

**Scope:** Unified MCP Server audit remediation and functional web control plane
**Accepted base:** `1ccc780` plus current remediation working tree
**Status:** audit remediation implemented; live Cloudflare/ChatGPT Web evidence and Rust toolchain remain pending

## Findings fixed

| Finding | Remediation | Evidence |
|---|---|---|
| Pruner could follow symlinked purge paths | `PrunerService.isSafePurgePath()` uses `lstat()`/`realpath()` for existing path components, rejects symlink boundaries, blocks root/system/home/app-data/workspace roots, and uses `lstat()` before removal. | `packages/extensions/src/pruner.ts`; `packages/extensions/src/pruner.test.ts`; `/tmp/unified-mpc-audit-pruner-symlink.mjs` |
| Web server accepted raw PID/server name for pruning | `ControlPlaneServer` issues opaque `serverId` values from `/api/servers`, maps IDs to discovered server records, and rejects unknown IDs, missing ownership proof, and raw PID input. | `apps/web/src/web-server.ts`; `apps/web/src/web-server.test.ts` |
| Async HTTP handler rejection could terminate process | HTTP callback attaches `handleRequestFailure()`, returns `500`, and preserves server availability after dependency rejection. | `apps/web/src/web-server.ts`; `apps/web/src/web-server.test.ts`; `/tmp/unified-mpc-audit-async-callback.mjs` |
| Gateway start/stop race could resurrect stale bridge | `GatewayService` fences each start with `startGeneration`; `stop()` increments generation and stale completions return `CONFLICT` without mutating state. | `apps/cf-gateway/src/gateway-service.ts`; `apps/cf-gateway/src/gateway-service.test.ts`; `/tmp/unified-mpc-audit-gateway-race.mjs` |
| Unsupported install/prune targets could report success | Installer and pruner validate targets against the supported set and return `UNSUPPORTED_TARGET`; web maps this to HTTP `422`. | `packages/extensions/src/installer.ts`; `packages/extensions/src/pruner.ts`; `apps/web/src/web-server.ts`; related tests |
| CLI created SQLite state before argument dispatch | `createDefaultCliDependencies()` lazily creates workspace/database dependencies only when a command needs them; `help` does not create runtime state. | `apps/cli/src/index.ts`; `apps/cli/src/index.test.ts` |
| Unsupported checkpoint envelope could be quarantined/replaced | `CheckpointKeyStore` now fails closed and leaves foreign or malformed key data untouched; quarantine option and behavior removed. | `packages/storage/src/checkpoint-key-store.ts`; `packages/storage/src/checkpoint-key-store.test.ts`; `/tmp/unified-mpc-audit-checkpoint-key.mjs` (script requires update to current fail-closed API) |
| Web accepted caller-controlled workspace and purge paths | `ControlPlaneServer` accepts only server-registered workspace roots, canonicalizes skill sources before containment checks, and rejects caller-supplied `purgeDataDirs`. | `apps/web/src/web-server.ts`; `apps/web/src/web-server.test.ts` |
| Installer/pruner could report destructive false success | Installer validates server identifiers, transport, and scope; malformed config fails closed without replacement. Installer and pruner use an OS lock plus in-process queue, restore prior config bytes on failed multi-target mutations, move purge data into Recovery Trash before completion, and restore moved data after later failure when possible. | `packages/extensions/src/config-mutation-lock.ts`; `packages/extensions/src/installer.ts`; `packages/extensions/src/installer.test.ts`; `packages/extensions/src/pruner.ts`; `packages/extensions/src/pruner.test.ts`; `scripts/test-config-mutation-lock.mjs` |
| Checkpoint key parent could inherit unsafe permissions or symlink traversal | Parent components are checked as trusted directories, owned by current user, and forced to mode `0700`; root directory is not chmodded. | `packages/storage/src/checkpoint-key-store.ts`; `packages/storage/src/checkpoint-key-store.test.ts` |

## Web control plane current contract

- `apps/web` uses native `node:http`; no frontend framework or CDN dependency.
- `apps/web/src/dashboard-html.ts` composes `apps/web/src/ui/tokens.ts`, `apps/web/src/ui/views.ts`, and `apps/web/src/ui/client-script.ts`.
- Listener binds to `127.0.0.1`; `Host` must be loopback.
- Mutations and `GET /api/chatgpt-web/connect` require loopback `Origin`; foreign or malformed origins return `403`.
- Request bodies are capped at 1 MiB and oversized bodies return `413`.
- ChatGPT Web connect returns `412` unless gateway state is `BRIDGE_HEALTHY`.
- Server pruning requires server-issued `serverId`; caller-supplied `name`/`pid` is not accepted.
- Workspace-scoped web mutations require an exact root registered by `ControlPlaneServer`; skill sources must resolve inside a registered root.
- Web server pruning rejects caller-supplied `purgeDataDirs`; global scope remains server-selected and workspace scope remains explicit.
- Web mutations use startup-rotated capability cookie/header with constant-time comparison; status/logs never expose token.
- Gateway uses real `cloudflared` process lifecycle, MCP identity probe, measured latency, explicit `/mcp` URL, named-tunnel configuration, and cleanup on failure/stop.
- MCP HTTP public access requires explicit hostname/origin allowlists; defaults remain loopback-only.

## Legacy cleanup

The obsolete `.agents/skills/lnwjud-scheduled-continuation/SKILL.md` path is deleted. Active runtime/config/test references use `Unified-MPC` naming. Remaining `lnwjud` matches, if any, belong only to provenance or historical documentation and require review before claiming a zero-residue result.

## Verification record

- Verified on current working tree based on `1ccc780` plus current remediation files.

- Typecheck: `corepack pnpm typecheck` — passed, `EXIT_CODE=0`.
- Serial workspace build: `corepack pnpm -r --workspace-concurrency=1 build` — 20 workspace projects passed, `EXIT_CODE=0`.
- Serial workspace tests: focused extension/storage/CLI/web suites passed; full recursive test command remains the final release gate.
- Web tests: `corepack pnpm --filter @unified-mpc/web test` — 3 test files, 40 tests passed, `EXIT_CODE=0`.
- Root integration tests: `npx vitest run tests/` — 2 test files, 2 tests passed, `EXIT_CODE=0`.
- Previously recorded audit repros remain evidence for the earlier remediation slice. `/tmp/unified-mpc-audit-checkpoint-key.mjs` requires adaptation to the current fail-closed API before it can be treated as a current executable check.
- Legacy grep: `grep -RInE 'LNWJUD_|resolveLnwjud|quarantineUnsupported|lnwjud-scheduled-continuation' apps packages scripts tests native .github ...` — no hits.
- `git diff --check` — passed, `EXIT_CODE=0`.

### Current focused verification

- `corepack pnpm --filter @unified-mpc/web test` — 3 test files, 36 tests passed, `EXIT_CODE=0`.
- `corepack pnpm --filter @unified-mpc/extensions test` — 9 test files, 79 tests passed, `EXIT_CODE=0`.
- `corepack pnpm --filter @unified-mpc/web typecheck` — passed, `EXIT_CODE=0`.
- `corepack pnpm --filter @unified-mpc/extensions typecheck` — passed, `EXIT_CODE=0`.
- `corepack pnpm --filter @unified-mpc/cli typecheck` — passed, `EXIT_CODE=0`.
- Targeted ESLint for changed extension source/test files — passed, `EXIT_CODE=0`.
- Extension transaction regression: `corepack pnpm --filter @unified-mpc/extensions test` — 9 test files, 81 tests passed, `EXIT_CODE=0`; covers Recovery Trash, rollback, OS-lock self-check, shared install/prune serialization, config rollback, and malformed-config fail-closed behavior.
- Extension transaction uses an OS lock keyed by config set plus an in-process queue; acquisition times out fail-closed rather than reclaiming a possibly reused PID's lock. `node scripts/test-config-mutation-lock.mjs` verifies two separate processes serialize.
- Purge data moves into Recovery Trash with a recovery ID before completion. Session/config failure restores moved paths when possible; errors expose `recoveryStatus` as `partial` or `rollback_failed`.
- Release gate is `corepack pnpm release:verify`; local Rust verification remains blocked when `cargo` is unavailable. External MCP fixtures cover legacy and modern child handshakes; live ChatGPT Web and Cloudflare evidence remain operator-gated.
