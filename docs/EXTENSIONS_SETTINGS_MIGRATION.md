# Extensions Settings Migration (Issue #4, slice 2)

The persisted `extensions` settings document is reconciled at startup before any
runtime policy, catalog or generated client block reads it. This document
describes the upgrade contract for documents written before the native-capability
topology replaced the mandatory child `memory` / `thai-rag-mcp` servers.

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

## Out of scope in this slice

This slice reconciles the persisted settings document only. Generated IDE policy
blocks, discovered child registry pins and the startup reconciliation marker for
those surfaces remain tracked in issue #4.
