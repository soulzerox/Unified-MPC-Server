# Audit Remediation Record

**Scope:** Unified MCP Server audit remediation and functional web control plane
**Accepted base:** `2040fd6cc31d9e6bc99e7578e762991d74313764`
**Status:** web and extension mutation slice remediated; gateway, CLI, release-policy, and reporting-channel gaps remain open

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
| Installer/pruner could report destructive false success | Installer validates server identifiers, transport, and scope; malformed config fails closed without replacement. Installer and pruner share an in-process transaction lock, restore prior config bytes on failed multi-target mutations, and propagate session, config, and deletion failures. | `packages/extensions/src/config-mutation-lock.ts`; `packages/extensions/src/installer.ts`; `packages/extensions/src/installer.test.ts`; `packages/extensions/src/pruner.ts`; `packages/extensions/src/pruner.test.ts` |

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

## Legacy cleanup

The obsolete `.agents/skills/lnwjud-scheduled-continuation/SKILL.md` path is deleted. Active runtime/config/test references use `Unified-MPC` naming. Remaining `lnwjud` matches, if any, belong only to provenance or historical documentation and require review before claiming a zero-residue result.

## Verification record

- Verified on working tree based on `2040fd6cc31d9e6bc99e7578e762991d74313764` plus seven modified files and one new source file.

- Typecheck: `corepack pnpm typecheck` — passed, `EXIT_CODE=0`.
- Serial workspace build: `corepack pnpm -r --workspace-concurrency=1 build` — 20 workspace projects passed, `EXIT_CODE=0`.
- Serial workspace tests: `corepack pnpm -r --workspace-concurrency=1 test` — 193 test files passed, 1,812 tests passed, 1 skipped, `EXIT_CODE=0`.
- Web tests: `corepack pnpm --filter @unified-mpc/web test` — 3 test files, 36 tests passed, `EXIT_CODE=0`.
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
- Extension transaction regression: `corepack pnpm --filter @unified-mpc/extensions test` — 9 test files, 79 tests passed, `EXIT_CODE=0`; covers shared install/prune serialization, config rollback, and malformed-config fail-closed behavior.
- Extension transaction implementation uses one in-process lock; cross-process writers remain outside this slice.
- Config rollback restores captured config bytes and removes newly created config files when a transaction fails; it cannot restore data already removed by `purgeDataDirs` after a partial deletion.
- Remaining open gaps: real Cloudflare tunnel/health contract, CLI `--host`/`doctor`, release checklist link/platform scope, vulnerability-reporting channel, checkpoint-parent permissions, external MCP handshake, PID identity/descendant shutdown, release packaging, and tracked reproducible audit evidence.
