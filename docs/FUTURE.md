# FUTURE — Deferred Platform Features (the Future record)

Owned place for everything v0.1 does not ship (ADR 0001/0003). **Deferred, not deleted.** Each entry names its original content, the seam it requires, and its re-entry criteria. The platform (entry 5) is a future layer built **on** the gateway, never inside it.

| # | entry | original content | required seam | re-entry criteria |
|---|---|---|---|---|
| 1 | Universal Engineering Harness | [`docs/future/HARNESS.md`](future/HARNESS.md) | ExecutionPipeline + EventEnvelope | harness threat model; turn-limit/cancellation/rollback tests against the seam |
| 2 | Installer (skill/server pipelines) | [`docs/future/INSTALLER.md`](future/INSTALLER.md) | IngestionSource (future) | sandbox proof — scripts never execute at install; provenance policy for tarballs |
| 3 | Pruner (zero-artifact deletion) | [`docs/future/PRUNER.md`](future/PRUNER.md) | installer's resource lifecycle | prunes installer-created resources; zero-orphan PID/directory test |
| 4 | Lifecycle updater | [`docs/future/LIFECYCLE.md`](future/LIFECYCLE.md) | UpdateSource (future) + EventEnvelope | provenance policy; update-rollback tests |
| 5 | Orchestrator / agent runtime platform | ADR 0001 | ExecutionPipeline + StateSplit | orchestrator trust model distinct from gateway authority |
| 6 | Priority-compile / IDE sync | [`docs/future/POLICY-COMPILE.md`](future/POLICY-COMPILE.md) | IdeTargetWriter (future) | per-target atomic-write tests; v0.1 request-policy engine proven |
| 7 | MCP-over-TCP client transport (HTTP/SSE) | — | Transport | designed threat model: bearer lifecycle, origin, exposure strategy |
| 8 | Accounts / multi-tenant control plane | — | Auth | hosted-mode threat model; session migration plan |

**Rule**: a future entry starts only through its seam; no pull request may widen v0.1 to host one (ADR 0001). Reserved seam names — IdeTargetWriter, IngestionSource, UpdateSource — are contractual placeholders only; their interfaces are designed when their entry is scheduled.

**Legacy references**: entries 1–4 and 6 still reference the obsolete seeds (`config/servers.json`, `config/policies.json`, `config.selfUpdate`, `ideTargets`) from the platform spec era. Those seeds are withdrawn (SPEC invariants 7; docs/CONFIG.md "no secrets by construction"). At re-entry, every such reference must be migrated to the unified strict config first — the seeds will not return.
