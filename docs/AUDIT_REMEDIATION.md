# Audit Remediation Record

**Scope:** Unified MCP Server audit remediation and functional web control plane
**Accepted base:** `3c4bfdfef6885b7471f6aae8dac901b7f882d4ad`
**Status:** remediation complete; verification recorded below

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

## Web control plane current contract

- `apps/web` uses native `node:http`; no frontend framework or CDN dependency.
- `apps/web/src/dashboard-html.ts` composes `apps/web/src/ui/tokens.ts`, `apps/web/src/ui/views.ts`, and `apps/web/src/ui/client-script.ts`.
- Listener binds to `127.0.0.1`; `Host` must be loopback.
- Mutations and `GET /api/chatgpt-web/connect` require loopback `Origin`; foreign or malformed origins return `403`.
- Request bodies are capped at 1 MiB and oversized bodies return `413`.
- ChatGPT Web connect returns `412` unless gateway state is `BRIDGE_HEALTHY`.
- Server pruning requires server-issued `serverId`; caller-supplied `name`/`pid` is not accepted.

## Legacy cleanup

The obsolete `.agents/skills/lnwjud-scheduled-continuation/SKILL.md` path is deleted. Active runtime/config/test references use `Unified-MPC` naming. Remaining `lnwjud` matches, if any, belong only to provenance or historical documentation and require review before claiming a zero-residue result.

## Verification record

Verified on the working tree based on `3c4bfdfef6885b7471f6aae8dac901b7f882d4ad` before commit.

- Typecheck: `corepack pnpm typecheck` — passed, `EXIT_CODE=0`.
- Serial workspace build: `corepack pnpm -r --workspace-concurrency=1 build` — 20 workspace projects passed, `EXIT_CODE=0`.
- Serial workspace tests: `corepack pnpm -r --workspace-concurrency=1 test` — 199 test files passed, 1,814 tests passed, 1 skipped, `EXIT_CODE=0`.
- Web tests: `corepack pnpm --filter @unified-mpc/web test` — 3 test files, 34 tests passed, `EXIT_CODE=0`.
- Root integration tests: `npx vitest run tests/` — 2 test files, 2 tests passed, `EXIT_CODE=0`.
- Audit repros: `/tmp/unified-mpc-audit-pruner-symlink.mjs`, `/tmp/unified-mpc-audit-gateway-race.mjs`, `/tmp/unified-mpc-audit-installer.mjs`, and `/tmp/unified-mpc-audit-checkpoint-key.mjs` all passed. Pruner rejects symlink escape and victim survives; stale gateway start leaves `STOPPED`; installer returns `UNSUPPORTED_TARGET` and creates no files; foreign checkpoint envelope fails closed, remains unchanged, and creates no quarantine file.
- Legacy grep: `grep -RInE 'LNWJUD_|resolveLnwjud|quarantineUnsupported|lnwjud-scheduled-continuation' apps packages scripts tests native .github ...` — no hits.
- `git diff --check` — passed, `EXIT_CODE=0`.
