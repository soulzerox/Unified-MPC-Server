# Extensions Settings and Policy Artifact Migration (Issue #4)

The persisted `extensions` settings document is reconciled at startup before any
runtime policy, catalog or generated client block reads it. Already-generated
client policy artifacts are then repaired from the reconciled settings. This
document describes the upgrade contract for installations written before the
native-capability topology replaced the mandatory child `memory` /
`thai-rag-mcp` servers.

## Startup reconciliation markers

An upgrade is driven by two independent markers. Both are idempotent, so a start
that dies between them converges on the next run instead of needing a manual
repair.

| State | Marker | Source of truth |
| --- | --- | --- |
| Database schema | the `schema_migrations` row `045_retire_turn_persistence` | `CURRENT_SCHEMA_MIGRATION_ID` in `packages/storage/src/database.ts` |
| Settings document | `settingsVersion: 2` | `EXTENSIONS_SETTINGS_SCHEMA_VERSION` in `packages/extensions/src/types.ts` |

The schema marker is the migration row itself: there is no separate "upgrade
done" flag that can disagree with the migrations that actually ran. A database
that already recorded the row skips it, and a clean install records it by
applying every migration in order.

```json
{
  "settingsVersion": 2,
  "...": "existing settings fields"
}
```

The settings marker lives inside the existing settings JSON, so the
reconciliation is one atomic row write and needs no extra table. A document
without the marker is treated as pre-migration.

Startup order:

| Entry point | Reconciliation point |
| --- | --- |
| `createStdioMcpRuntime` | immediately after the settings repository is opened |
| `runWeb` | immediately after non-secret settings bootstrap, before `ControlPlaneServer` |

Both call `ensureExtensionsSettingsMigrated(store, EXTENSIONS_SETTINGS_KEY)`.
The migration is deterministic, so two hosts that start against the same database
compute the same document and the last write does not change the result.

## What is migrated

Only a document below version 2 is migrated. A document that already carries
`settingsVersion: 2` is authoritative user state and is returned unchanged, so a
policy the user re-enables (for example a mandatory Godkiller policy saved from
the WebUI) is never forced back to a legacy default on restart.

For pre-versioned documents with built-in/default provenance only:

| Before | After |
| --- | --- |
| `child:memory` (`server`, `REALTIME`, `requiredTools`) | `memory:workspace-selective` (`capability`, `ON_DEMAND`, `requiredCapabilities`) |
| `pre-edit:thai-rag` (`server`, `EVERY_SESSION`, `requiredTools`) | `code:pre-edit-context` (`capability`, `SAFETY_PRE_CHECK`, `requiredCapabilities`) |
| mandatory `code-safety:godkiller` child policy | optional on-demand `code-safety:godkiller` policy |
| `mandatoryMcpServers` containing retired built-in names | names removed |

The capability policies are the current entries in `DEFAULT_POLICIES`; the
migration does not duplicate them when a user already saved the same policy id.

## Provenance rule

`migrateExtensionsSettings` uses two signals:

1. A policy whose id, resource id and resource type match a released built-in
   default (`child:memory`, `pre-edit:thai-rag`, old mandatory Godkiller) is
   built-in provenance.
2. A name present in `extraMcpServers` is explicit user configuration.

A user-defined server named `memory` or `thai-rag-mcp` in `extraMcpServers` keeps
its policy and its mandatory pin. The runtime policy surface also stops filtering
those policies (`configuredPolicies`).

## Ambiguous documents are preserved

A retired mandatory name is removed only when:

- it has a matching migrated built-in policy, or
- the document has no saved policy list at all (the value can only have come
  from the released defaults, and no explicit `extraMcpServers` entry exists).

When a saved policy list is present but does not cover the retired name, the name
is preserved and the run reports `ambiguous-mandatory-server-preserved`. The
preserved name is inert: `configuredPolicies` will not create a mandatory child
pin for any retired built-in id (`memory`, `thai-rag-mcp`, `godkiller`) that is
not an explicit `extraMcpServers` entry. Godkiller is an on-demand safety check,
not a mandatory child server.

Similarly, a malformed JSON document is reported as `invalid-settings-json` and
left untouched; it is never replaced by defaults or half-written.

## Notice codes

| Code | Meaning |
| --- | --- |
| `legacy-policy-migrated` | A released built-in policy row was replaced by its capability/on-demand form. |
| `legacy-mandatory-server-removed` | A released built-in mandatory child pin was removed. |
| `user-defined-server-preserved` | A retired name is kept because `extraMcpServers` defines it. |
| `user-defined-policy-preserved` | A legacy-looking policy is kept because its server is user-defined. |
| `ambiguous-mandatory-server-preserved` | A saved policy list does not prove built-in provenance, so the name was kept. |
| `invalid-settings-json` | The persisted row is not a JSON object; no write happened. |

## Child MCP registry and pin state

An upgrade must not keep a child server running, or required, because stale
configuration still describes the old topology. Three properties provide that:

- **No persisted pin store exists.** A connected child is pinned only in memory:
  `McpSessionManager.pinnedServers` is a `Set` that starts empty in every new
  process. `McpSessionManager.reconcile()` drops a pin as soon as the server is
  disabled, excluded, removed, or its launch configuration changes, so a restart
  cannot resume a topology that no longer appears in the reconciled settings.
- **The persisted input is reconciled.** The only settings fields that describe
  the child topology are `mandatoryMcpServers` and the policy list, and both are
  migrated above. Retired names are removed unless a user-defined server
  justifies keeping them.
- **A preserved name stays inert.** `configuredPolicies` refuses to synthesize a
  mandatory pin for a retired built-in id (`memory`, `thai-rag-mcp`,
  `godkiller`) unless `extraMcpServers` defines that exact name. An
  ambiguously-preserved entry therefore cannot resurrect the child topology.

A user-installed server that legitimately reuses one of those names still works:
it is reached through `extraMcpServers` and its own policy, never through the
retired built-in default.

## Generated client policy artifacts

`IdeSyncService.repairManagedBlocks` converges artifacts that were generated
before the settings migration. It runs automatically:

| Entry point | Scope | Timing |
| --- | --- | --- |
| `createStdioMcpRuntime` | Active workspace only | Started right after the settings migration, awaited by `close()` |
| `runWeb` with `repairManagedPolicies: true` (the CLI `web` command) | Host-global files plus the first configured `workspaceRoots` entry, defaulting to `process.cwd()` like `ControlPlaneServer` | Awaited before `ControlPlaneServer.listen()` |

Scope split is deliberate. A per-session stdio host must never rewrite
`~/.config/opencode/AGENTS.md`, `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` or
the other host-global instruction files: starting one project's session cannot
be allowed to change instructions that belong to every project. The long-lived
control plane owns those files. Workspace artifacts are repaired by both paths.

`repairManagedBlocks` differs from `sync` in three ways that matter for an
upgrade:

- It only rewrites an artifact that already exists **and** already carries
  exactly one ordered `<!-- MCP-POLICY-START -->` … `<!-- MCP-POLICY-END -->`
  block. That gate covers the whole-file targets
  (`.cursor/rules/00-mandatory-policy.mdc`,
  `~/.gemini/antigravity/rules/mcp-policy.md`) too. Every other shape is
  ambiguous and is left byte-identical and reported in `skipped[]`: a file with
  only one of the two markers, a file whose closing marker precedes its opening
  marker, and a file that repeats a marker. Rewriting part of an ambiguous file
  is exactly how an automatic repair would append a second block or leave a
  stale one behind, so it never creates a file and never appends a managed
  block. An upgrade therefore cannot start instructing an IDE or CLI the user
  never configured. Use `sync` (or the WebUI "Sync Policies" action) to opt in
  to a new target; if an artifact does carry a duplicated block, delete the
  extra pair once and the next startup repairs it.
- Every write is atomic and every target is independent. One unreadable file is
  reported in `failed[]` without aborting the remaining repairs.
- It compiles from the same `policySnapshot()` as `sync`, so startup repair and
  a later manual sync converge on identical bytes. Running it again reports the
  artifact as `unchanged` and rewrites nothing.

The result is a `ManagedPolicyRepairReport` with `scanned`, `updated`,
`unchanged`, `skipped` and `failed` entries. A failed repair never blocks
startup. The stdio runtime exposes the report as `managedPolicyRepairReady`;
`runWeb` returns it as `policyRepair`; the CLI prints updated and failed counts
before announcing the control-plane URL.

## Interruption, concurrency and diagnostics

The migration is safe to interrupt and safe to start twice at the same time.

- **Concurrent startups cannot corrupt the settings row or a managed block.**
  Settings reconciliation is one row write of a deterministic document, so the
  last writer produces the same bytes. Managed-block repair runs the whole
  read-modify-write pass under the shared per-file config mutation lock
  (`withConfigMutationLock`). Install, prune and canonical-registry writes take
  the same lock through `withConfigMutationTransaction`, so a repair and a
  concurrent mutation cannot interleave.
- **A killed writer does not block later startups.** Lock owners are staged in a
  private directory and published with one atomic `rename`, so a waiter never
  observes a half-created lock. A lock is reclaimed only when every recorded
  owner PID is provably dead, and an empty lock directory left by a release that
  died between `unlink` and `rmdir` is reclaimed after a 5 s grace.
- **An interrupted repair is retried on the next start.** `repairManagedBlocks`
  rewrites an artifact only when it carries exactly one ordered managed block,
  so a rerun converges without appending a second block. `sync` (or the WebUI
  "Sync Policies" action) remains the explicit opt-in for a target that has no
  block yet.
- **A whole-run repair failure is reported, not dropped.** `runWeb` returns it as
  `WebRunResult.policyRepairError` and the `web` command prints
  `Policy repair failed: ...`; the stdio runtime writes
  `Unified-MPC managed policy repair failed: ...` to stderr, keeping stdout for
  the MCP protocol. A per-file failure still appears in `failed[]` and never
  stops the remaining targets.
- **A malformed settings row is reported, not rewritten.** It is surfaced as
  `invalid-settings-json` and left untouched, so recovery is a repair of that one
  JSON row rather than a manual schema edit.
- **Destructive schema work is backed up and transactional.** Before the first
  pending migration runs against an existing database, `SqliteDatabase` writes a
  pre-migration backup when `backupDirectory` is configured. A migration and its
  `schema_migrations` insert share one transaction, so a rollback cannot leave a
  half-retired schema.

## Upgrade notes

1. Start any host once after upgrading: the CLI `web` command, the HTTP MCP
   service, or a stdio MCP session. All three run the schema migrations and the
   settings reconciliation; `web` also repairs the host-global generated policy
   artifacts.
2. Read the migration result before trusting the runtime. The settings report
   carries `status` (`current`, `applied`, `invalid`) plus the notice codes
   above, and the repair report carries `scanned`, `updated`, `unchanged`,
   `skipped` and `failed`.
3. Investigate any `*_preserved` notice before deleting a retained name. It
   means the document did not prove built-in provenance, so the name may belong
   to the user.
4. Delete a duplicated managed block once if an artifact already carries two
   marker pairs; the next startup repairs the single remaining block. A target
   that has no managed block is only written by `sync`.
5. Manual SQLite or JSON editing is not a supported recovery path for a normal
   migration failure. `invalid-settings-json` is the one case that needs the
   settings row repaired by hand, because the migration deliberately refuses to
   replace a document it cannot parse.
