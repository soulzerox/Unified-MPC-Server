# Extensions Settings and Policy Artifact Migration (Issue #4, slices 2-3)

The persisted `extensions` settings document is reconciled at startup before any
runtime policy, catalog or generated client block reads it. Already-generated
client policy artifacts are then repaired from the reconciled settings. This
document describes the upgrade contract for installations written before the
native-capability topology replaced the mandatory child `memory` /
`thai-rag-mcp` servers.

## Version marker

```json
{
  "settingsVersion": 2,
  "...": "existing settings fields"
}
```

`EXTENSIONS_SETTINGS_SCHEMA_VERSION` in `@unified-mpc/extensions` is the current
version (`packages/extensions/src/types.ts`). A document without the marker is
treated as pre-migration. The marker lives inside the existing settings JSON, so
the reconciliation is one atomic row write and needs no extra table.

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

## Generated client policy artifacts (slice 3)

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

- It only rewrites an artifact that already exists **and** already contains a
  complete `<!-- MCP-POLICY-START -->` … `<!-- MCP-POLICY-END -->` block. That
  gate covers the whole-file targets (`.cursor/rules/00-mandatory-policy.mdc`,
  `~/.gemini/antigravity/rules/mcp-policy.md`) too, and a file with only one of
  the two markers is skipped rather than having a second block appended. It
  never creates a file and never appends a managed block, so an upgrade cannot
  start instructing an IDE or CLI the user never configured. Use `sync` (or the
  WebUI "Sync Policies" action) to opt in to a new target.
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

## Out of scope in these slices

These slices reconcile the persisted settings document and the generated
artifacts it feeds. Concurrency/interrupted-migration recovery, clean-install
parity tests and the child-registry pin surface remain tracked in issue #4.
