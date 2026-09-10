# 0003 - Versioned config editing via the control plane; deferred features recorded with required seams

- Status: Accepted
- Date: 2026-09-11
- Deciders: product owner

## Context

The policy engine is the heart of the gateway; a web destination that cannot edit policy would not be the destination. But the audit mandates that config changes be schema-versioned, validated, and migration-safe. Separately, SPEC.md promises harness, orchestrator, installer, and remote connector features the gateway cannot host in v0.1.

## Decision

The web control plane edits unified config and policy **through schema version + validation + diff-confirm** in v0.1 (versioned documents, migration path, no free-form rewrites). Deferred platform features (harness, orchestrator, installer, remote connector) move to an explicit **Future / Out-of-scope** record (`docs/FUTURE.md`), each annotated with the seam it requires from v0.1 (event envelope, transport seam, state split), rather than being deleted or left unowned in the spec.

### Clarification (2026-09-11, reconciliation with the strict-config constraint)

Combined with the earlier user constraint that the gateway's config file is strict and **read once, never written** (absolute `--config` path, unknown fields rejected, duplicate/invalid IDs rejected, relative command/cwd paths rejected, group/world-writable or non-regular file rejected, no secret values): the **gateway runtime never writes the config and never hot-reloads it**. The control plane is the only writer: it validates, shows a diff, writes the new version atomically, archives the previous version to history, and changes **apply on restart** - the control plane offers a one-click graceful restart.

## Consequences

- v0.1 ships with working policy/config editing, but every change is traceable and reversible through versioned migration.
- Future features have an owner (the Future record) and a contract (the seams), so they can start without spec archaeology.
- Config format changes require a version bump + migration, never silent in-place rewrites.
- No hot-reload in v0.1: apply-on-restart is the apply path.

## Alternatives

- Read-only UI in v0.1, edits via files/CLI: rejected - makes the web destination incomplete.
- Free-form config edits: rejected - violates the audit's migration-safety mandate.
- Silent deletion of platform features: rejected - loses the destination and the seam contracts.
- Runtime hot-reload with file watching: rejected - contradicts the strict read-once config constraint.