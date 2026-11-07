# Unified #210 slice — send the canonical source identity on `code_index` (§13)

Issue: soulzerox/Unified-MPC-Server#210 (§1 identity, §13 cross-repo ownership,
2026-10-26 Thai-RAG contract addendum).

Companion: soulzerox/thai-rag-mcp#1 (Provider Contract), thai-rag-mcp#60
(scoped delta + source fence), thai-rag-mcp#61 (standalone).

Status: design. The provider half already exists; this slice is the caller half.

## What already exists

Thai-RAG accepts and validates a canonical identity on `code_index` today:

| File | Role |
| --- | --- |
| `thai_rag/source_identity.py` | validates `source_identity`, refuses unknown fields |
| `thai_rag/source_fence.py` | validates `expected_paths` / `deleted_paths`, compares live bytes |
| `thai_rag/retriever.py` | requires generation mode, refuses `stale_index` with `stale_paths` |

The accepted shape (shape-only validation, fail-closed):

| Field | Required | Rule |
| --- | --- | --- |
| `repository_id` | yes | non-empty, no NUL |
| `manifest_id` | yes | `man:v1:<64-hex>` |
| `ref` | no | starts with `refs/`, no `..` |
| `commit_sha` | no | exact 40/64-hex Git object id |
| `tree_oid` | no | exact 40/64-hex Git object id |
| `revision_id` | no | `rev:v1:<64-hex>` |

`expected_paths` is `{ repo-relative path: 64-hex content hash }`. `deleted_paths`
is a list of declared removals whose members **must not** appear in
`expected_paths`: the provider refuses the overlap as a contradiction
(`deleted_paths cannot also be expected with a content hash`). A removal is
honored, not fenced — the caller owns the path set, the provider owns hiding it.
`source_identity` and `expected_paths` require generation mode; `deleted_paths`
alone is accepted in legacy mode too.

Refusals already defined by the provider:

- malformed or unknown-field identity → `status: error`, `code: invalid_input`;
- live bytes no longer match a declared hash → `status: stale`, `code:
  stale_index`, with the exact `stale_paths`;
- `workspace_path` not bound to `workspace_id` → `code: workspace_root_mismatch`.

## The gap

Unified never sends any of it. `NativeThaiRagProvider.codeIndex()` builds:

~~~text
workspace_path, workspace_id, force, background?, vectors, paths?, max_files?
~~~

(`apps/cli/src/runtime/native-thai-rag-provider.ts`)

Consequences:

1. A published semantic generation records no canonical revision, so base+overlay
   resolution (#60) has nothing to anchor to.
2. The source fence is dead code: an index request derived from revision M can
   publish after a path moved past M. There is no stale rejection because no
   expectation was declared.
3. §13's "exact fields passed to Thai-RAG" is only half delivered: the schema
   exists, the caller does not use it.

## Slice design

### 1. Resolve the binding from the canonical store

Add one resolver, owned by `packages/workspace`, not the CLI:

~~~ts
resolveCanonicalSourceIdentity(input: {
  canonicalRoot: string;                            // <dataPath>/canonical
  canonicalRef: string;                             // refs/remotes/origin/main
  expectedRepositoryIds: readonly string[] | null;  // this checkout's origin
  goal: { goalWorkspaceId: string } | null;
}): Promise<CanonicalSourceResolution>
~~~

The caller passes the exact ref it means to bind. The runtime supplies a
`canonicalRefFor(workspace)` port that resolves it where the inputs already live
— `resolveGoalBaseBranch(realRootPath, branchName, mergePolicy)` +
`canonicalRefForBranch(defaultBranch)` — because the driver itself has no branch
or merge-policy port and must not grow one. The resolver never scans the store
or picks among refs.

- **Plain checkout.** Strict-read the named ref and its manifest. The manifest
  `repositoryId` must be in `expectedRepositoryIds`. A missing ref is `absent`:
  a repository with an origin that has never promoted one is unbound, and with
  `expectedRepositoryIds === null` (no origin) no canonical ref can ever be
  bound.
- **Goal workspace.** Strict-read the named ref and the overlay, then run
  `verifyGoalAdmission(refs, overlays, { goalWorkspaceId, canonicalRef })`.
  `verifyGoalAdmission` itself reads the ref tolerantly (`refs.read` returns
  `null` for a corrupt file), so the resolver must not treat its `null` result
  as "never promoted": it strict-reads first, or `verifyGoalAdmission` gains a
  strict option. A corrupt ref is an error, never `goal_unadmitted`.
  `admitted: true` binds the returned `baseManifestId`. `admitted: false` is
  **not** a store error and must not block indexing: Goal creation deliberately
  succeeds with no pin when the base was not the live canonical ref
  (`no_canonical_ref`, `commit_not_live`, `repository_mismatch`). Since rollout
  step 4, a durably completed `rebaseStaleBase` advances `baseRevision` and
  re-pins the overlay at the new base when that commit is live. The guarded
  rebase is not yet exposed as an MCP operation, though, so a creation-time
  skip still has no automatic re-pin path: it binds again only after such a
  rebase runs. In both unadmitted cases the request proceeds unbound
  (expectations only once §3's skip rule is released), sends no
  `source_identity`, and records `canonical_binding: 'goal_unadmitted'` plus
  the admission reason. Only a genuinely missing overlay is `goal_unadmitted`;
  a corrupt or unreadable overlay is an error.

It returns a resolution, not a bare identity:

~~~ts
type CanonicalSourceResolution =
  | { status: 'bound'; identity: CanonicalSourceIdentity }
  | { status: 'absent'; reason: 'no_repository' | 'no_canonical_ref' }
  | { status: 'goal_unadmitted'; reason: string };   // no identity

interface CanonicalSourceIdentity {
  repository_id,      // manifest.repositoryId
  manifest_id,        // man:v1:… (the admitted Goal base)
  revision_id,        // rev:v1:…
  commit_sha,
  tree_oid,
  ref,                // canonicalRef
}
~~~

`absent` is only "this repository can never bind a canonical ref" (no origin,
or no ref has ever been promoted). `goal_unadmitted` is the legitimate Goal
state described above, not a store failure. Every other state is an error: a
foreign manifest, a corrupt ref (plain or Goal), a dangling manifest record, and
a mismatched `repository_id` all refuse. Reads are strict
(`CanonicalRefStore.read(ref, { strict: true })`,
`CanonicalManifestStore(..., { strictReads: true })`) so a corrupt store is
reported instead of being read as "never promoted". The resolver also reads the
overlay strictly before calling `verifyGoalAdmission`, so a corrupt overlay is
an error while a missing one is `goal_unadmitted`.

### 2. Send it only for a view the revision actually describes

The adapter owns this decision, not the resolver: it already collects
`WorkspaceSourceEvidenceIdentity` (head, dirty state and staged fingerprints)
for admission, and compares that to the resolver's `commit_sha`.

`source_identity` claims "these bytes are revision M". Send it only when that is
true:

- a clean checkout whose HEAD is the manifest commit, or
- a Goal workspace whose admission-verified logical view is the source indexed.

A dirty plain checkout is not representable: the revision does not contain its
uncommitted bytes, and the identity schema has no dirty marker. That request
carries expectations only once the skip rule in §3 is released, and records
`canonical_binding: 'dirty'`; it never attaches revision M to bytes it does not
contain. Untracked additions in a scoped request are the same case.

`canonical_binding` is a Unified-side field in the index result and job ledger —
operator-facing state, never sent to the provider, whose identity validator would
refuse an unknown field. It records the identity claim: `bound`, `dirty`,
`absent`, `goal_unadmitted` or `unsupported`. `canonical_fence` is its companion:
`fenced` (expectations sent), `unfenced` (a manifest is known but expectations
were omitted) or `none` (no expectations possible). Precedence for
`canonical_binding`: `absent` (no ref), `goal_unadmitted`, `dirty`, `unsupported`
(flags missing), otherwise `bound`. Every identity field comes from the
ref/manifest record.
`WorkspaceSourceEvidenceIdentity` may decide *whether* to send, but never supplies
a binding field: its `repositoryIdentity` is admission evidence, not
`repository_id`.

This decision needs facts that do not reach `codeIndex()` today. All are
additive plumbing in this slice, not provider changes:

- **Goal identity.** `NativeThaiRagWorkspace` carries only `id`, `rootPath` and
  `realRootPath`, and both workspace paths drop `lifecycleKind`/`goalId`: the
  `workspacesProvider` mapping in
  `apps/cli/src/runtime/stdio-mcp-runtime.ts` and
  `createStrictThaiRagGoalAdmissionProvider` in
  `apps/cli/src/runtime/native-thai-rag-goal-admission.ts`. Widen the provider
  workspace type with both and stop dropping them in **both** paths; otherwise
  a strict FD3 workspace silently takes the plain-checkout branch. The overlay
  key is the workspace id itself (`pinGoalBaseAtCommit` is called with
  `registered.value.id`), so `goal: { goalWorkspaceId: workspace.id }` is
  supplied only for `lifecycleKind === 'goal'` with a non-null `goalId`; every
  other workspace takes the plain-checkout path.
- **Cleanliness and deletions (plain checkouts).**
  `WorkspaceSourceEvidenceIdentity` has no clean/dirty boolean, and the
  admission mapping drops `GitWorkspaceSnapshot.statusEntries`. Add
  `dirtyState: 'clean' | 'dirty' | 'unknown'` from
  `statusEntries.length === 0` (`unknown` when no observation exists), plus
  `deletedPaths: readonly string[]` from the entries whose kind is deleted.
  Compare `dirtyState` in `classifyWorkspaceSourceEvidence`; `unknown` on
  either side is ignored (the existing fingerprints still decide), so a legacy
  record never becomes stale solely for the missing field. For a **plain
  checkout**, anything other than `'clean'` is unbound (records `dirty`). A Goal
  workspace's worktree may legitimately be dirty because its overlay records
  the changed bytes; its binding is decided by admission and the overlay, never
  by `dirtyState`, so an admitted Goal with a non-empty overlay still binds.
  Do not infer cleanliness from `dirtyFingerprint`: the empty-string sentinel
  is an implementation detail, not a contract.
  `dirtyState` and `deletedPaths` are optional in the persisted
  `verification.json` reader (`isSourceIdentity`): a missing `dirtyState` reads
  as `unknown` and a missing `deletedPaths` as empty, so existing
  `schemaVersion: 1` records still parse and no migration or forced re-index is
  required.

### 3. Fence the bytes this call asks for

For an admitted Goal workspace, do not re-derive the merge:
`resolveGoalLogicalView(refs, overlays, …)` already verifies admission and
applies overlay-over-base with tombstones removed. Reuse it, and read the
overlay entries separately for `deleted_paths` (a tombstone is a declared
removal and must not appear in `expected_paths`). An unadmitted Goal cannot
call it — it throws on failed admission — so hash the scoped paths live and
send only the tombstones; a full request sends no expectations.

**Both shapes must survive the provider's skip policy.** The provider scanner
deliberately skips `gitignored`, `hidden`, `sensitive`, `minified_name`,
`minified_content`, `binary`, `too_large`, `symlink` and other reasons
(`thai_rag/source_scanner.py`, `_SKIP_REASONS`). `fence_violations` treats a
path missing from the scan as a violation with `observed_sha256: null`, so an
expectation for a skipped-but-present path becomes `stale_index` on a scoped
request just as on a full one. The provider therefore needs one rule before
Unified sends any expectation:

> an expectation is a violation only when the path was scanned and its hash
> differs, or when the path is absent from disk; a skipped-but-present path is
> reported as `unfenced_paths`, not as stale.

This is a provider rule, not a caller-side filter: matching `_SKIP_REASONS` in
Unified would be a second, drifting copy of the policy. One rule covers both
request shapes.

**Scoped request (`paths`).** An expectation is the hash of the byte the caller
believes it is publishing: the effective-view hash (overlay or manifest) for a
tracked, unmodified path, the live content hash for a dirty or untracked path. A
requested path that exists nowhere — neither on disk nor in the view — is refused
before the child call.

A tracked path deleted on disk is **never** an expectation: the scanner cannot
observe bytes for it, so any hash would be reported as an absent-path violation.
When a requested path is absent on disk but present in the view, it is declared
in `deleted_paths` and omitted from `expected_paths`; when it is absent from
both, the request is refused. The same rule applies to a full request: the
`deletedPaths` collected from `statusEntries` are sent as `deleted_paths`,
omitted from `expected_paths`, and the remaining tree leaves are fenced. A
removal is a declaration, not a fence, so it neither hides an unexpected live
file nor requires the skip rule.

> **Implementation note (2026-11-07).** The provider only ever reads the live
> byte, so the fence publishes the view hash only where the worktree still holds
> it; a tracked path whose bytes disagree with the view is fenced live and
> reported as drift. Declaring the view hash there made an ordinary dirty
> checkout — and an admitted Goal whose overlay has no entry yet for a change —
> fail the whole index as `stale_index`. The fence therefore carries
> `driftedPaths`, and the adapter downgrades the binding to `dirty`
> (`canonical_binding_reason: 'view_drift'` for a Goal) instead of claiming a
> view the worktree no longer contains. The overlay writer is a later rollout
> step; until it lands, a Goal with edits indexes unbound rather than failing.
>
> Two refinements are required so the identity claim stays true in every case
> the fence cannot see on its own. First, a live path the view does not describe
> is drift too: a scoped request naming a newly added file fences the live byte
> but must not report the view as the source. Second, a full request's fence is
> built from view keys, so an added file outside the overlay is invisible; the
> admission probe therefore persists the worktree's `changedPaths` (the
> additions counterpart to `deletedPaths`), and a Goal binds only when the
> worktree was clean or every changed path is described by the logical view or
> a tombstone. Drift is computed whether or not the child advertises
> `expected_hash_fence`: the flag gates what is sent, never whether the caller
> may claim the view, because a split-flag provider with no fence to build is
> not proof of "no drift".

Until the provider rule above is released, a scoped request sends no
`expected_paths` either: a requested hidden, ignored, sensitive, minified,
binary, oversized or symlinked path would otherwise turn an ordinary demand
index into `stale_index`.

**Full request (no `paths`).** The manifest is every leaf of the Git tree, so
the same rule is what makes the full map safe: skipped-but-present leaves are
reported as unfenced instead of stalling the pass. `deleted_paths` is still
sent for tracked deletions even while `expected_paths` is withheld.

Until the rule is released, neither shape sends expectations: record
`canonical_fence: 'unfenced'` when a manifest is known and `'none'` otherwise.
The binding field keeps its own value; the two are orthogonal. This is
explicitly weaker, labelled, never silently so.

### 4. Gate on the flags that already exist

The handshake already carries `revision_manifest` and `expected_hash_fence` as
top-level booleans (`CAPABILITY_FLAGS` in `thai_rag/provider.py`, emitted as
`**CAPABILITY_FLAGS`). The `capabilities` array is the operations list, not a
feature list, and Unified's `parseProviderHandshake` does not read the flags
today. So:

1. this repo parses those booleans into the handshake type and gates on
   `revision_manifest` and `expected_hash_fence`;
2. no new capability string and no `CONTRACT_FINGERPRINT` change;
3. if a new flag is ever needed it lives in `CAPABILITY_FLAGS`, which changes the
   fingerprint, so it must be added to `SUPPORTED_INDEX_JOB_CONTRACTS` here
   before the provider can ship it.

Flags absent → omit identity and expectations; record `canonical_binding:
'absent'` when no ref exists, otherwise `'unsupported'` (the binding exists but
this provider cannot consume it), and `canonical_fence: 'none'`.

### 5. What must not change

- `paths`/`max_files` semantics stay exactly as they are; the automatic
  admission pass now makes the same canonical claim as a demand pass (rollout
  step 5).
- The resolver never writes, promotes or repairs a ref.
- A workspace with no canonical ref — including a checkout with no origin, which
  can never have one — keeps indexing and records `absent`.
- An unadmitted Goal workspace keeps indexing and records `goal_unadmitted`; it
  is not an error and not a reason to refuse the child call.
- `canonical_binding` stays a Unified-side result field; the provider sees only
  `source_identity`, `expected_paths` and `deleted_paths`.
- The provider remains the only owner of semantic artifact identity; Unified
  sends source truth only.
- The automatic admission pass (`startWorkspaceAdmissionIndex`, which calls
  `code_index` directly with `max_files: 3` and then `mode: 'delta'`) resolves
  the same plan as `codeIndex()`: both calls carry the identity and fence, and
  the local job ledger records `canonical_binding`/`canonical_fence`. Its
  ordinary resolver outcomes keep indexing; a corrupt canonical store refuses
  the admission before any child call. A provider-loss restart re-issues the
  delta without identity, so the adapter drops the original anchor instead of
  claiming revision M for bytes that request never fenced.

> **Implementation note (2026-11-07, rollout step 5).** Admission resolves the
> plan once with an empty path set (a full request) and spreads the child fields
> into both the bounded trial and the delta, so the provider's intersection rule
> decides which of the declared paths it actually sees. The plan is held under
> the local admission job id, merged into the terminal job result as
> `canonical_binding`/`canonical_fence`, and dropped in the monitor's `finally`.
> A corrupt ref/manifest/overlay refuses the admission with
> `canonical_source_invalid` before any child call; `absent`, `goal_unadmitted`,
> `dirty` and `unsupported` keep indexing and only change what is recorded. The
> pass still only reads the worktree and the canonical stores: it never
> promotes, repairs or writes a ref.

## Test matrix

Unified side:

- `codeIndex()` forwards `source_identity` byte-for-byte for a clean checkout with
  an active manifest (regression shape of the dropped `paths` bug, #346 U10);
- a workspace with no canonical ref, and a checkout with no origin, send no
  `source_identity`, still index, and record `absent`;
- a corrupt ref read (plain and Goal), a dangling manifest and a foreign
  `repositoryId` are refused, never the quiet null; a failed Goal admission is
  not refused;
- a Goal workspace is bound only while its pinned base equals the live ref; a
  drifted or never-pinned Goal still indexes, sends no `source_identity`, and
  records `canonical_binding: 'goal_unadmitted'` with the reason; a scoped
  request uses live hashes and a full request sends no expectations;
- the admitted Goal binds its base manifest, including when its worktree is
  dirty because the overlay covers every changed path; a tombstone becomes
  `deleted_paths` and never `expected_paths`; a changed path the overlay does
  not describe (a modified file, a deletion without a tombstone, or an added
  file) records `dirty`/`view_drift` and sends no `source_identity`;
- a scoped request sends the effective hash per path; a dirty path uses the live
  content hash;
- a tracked deletion in a dirty plain checkout is sent as `deleted_paths`,
  omitted from `expected_paths`, for scoped and full requests alike;
- a requested path that exists nowhere is refused before the child call, and
  nothing is sent;
- before the provider skip rule, neither a scoped nor a full request sends
  `expected_paths`, and both record `canonical_fence: 'unfenced'` when a manifest
  is known (`'none'` otherwise);
- after it, a scoped request that names a skipped-but-present path is not
  `stale_index` (it is reported as unfenced), while a moved hash and an absent
  path still refuse;
- a dirty plain checkout sends expectations only for paths present on disk,
  declares tracked deletions in `deleted_paths`, records `canonical_binding:
  'dirty'`, and sends no `source_identity`;
- the adapter takes the Goal branch only for `lifecycleKind === 'goal'` with a
  non-null `goalId`, and both workspace paths (ordinary and strict FD3) carry
  those fields; only a plain checkout with `dirtyState: 'clean'` may carry
  `source_identity`, while an admitted Goal binds through its view whenever the
  worktree still holds that view and every changed path is described by it
  (worktree dirtiness alone does not unbind it); a view the fence reports as
  drifted, or a changed path outside view and tombstones, records `dirty`
  instead;
- a provider that cannot consume expectations but can record revisions computes
  drift anyway: a drifted Goal records `dirty`/`view_drift` and sends no
  `source_identity`, while a covered Goal still binds;
- an existing `verification.json` record without `dirtyState`/`deletedPaths`/
  `changedPaths` still parses (`unknown`/empty) and does not force a re-index;
  an empty change set on a dirty Goal never proves the view, so it stays
  unbound;
- the automatic admission pass resolves the same plan: the bounded trial and the
  delta both send `source_identity` and the full fence for a clean checkout, and
  the completed local job records `canonical_binding`/`canonical_fence`; a dirty
  checkout fences live bytes and declares `deleted_paths` (`dirty`); an admitted
  Goal sends its overlay expectations and tombstones (`bound`); a provider-loss
  restart re-issues the delta without identity and the ledger keeps no anchor; a
  corrupt canonical store refuses the admission before any `code_index` call;
- `stale_index` and `invalid_input` keep their provider code, status and retry
  classification (including `providerReason`); the provider's `stale_paths` /
  `unfenced_paths` detail fields are not forwarded to the caller;
- the gate: flags absent → binding `'absent'` or `'unsupported'` as above and
  fence `'none'`; flags present → identity and fencing;
- `canonical_binding` never appears in the child arguments;
- the existing conformance fixture still validates: this slice changes no
  fingerprint.

Provider side (follow-up in thai-rag-mcp):

- the intersection rule applies to scoped and full requests alike: a
  skipped-but-present path is `unfenced_paths`, an absent path is stale, and a
  scanned differing hash is stale;
- `scope_expected_paths` still keeps only the requested paths on a scoped
  request;
- an unchanged revision reuses the recorded anchor across a restart.

## Open decisions

1. **Which ref is this checkout's?** The store is store-wide, so the caller names
   the ref explicitly. The runtime supplies a `canonicalRefFor(workspace)` port
   that resolves it with `resolveGoalBaseBranch` + `canonicalRefForBranch` where
   `branchName` and the merge-policy port already exist; the driver receives no
   policy port. The resolver validates its manifest against
   `expectedRepositoryIds`. Recommended: this explicit ref, never a scan of
   store refs. A checkout with no origin has `expectedRepositoryIds === null`,
   can never match, and records `absent`.
2. **Fencing a request the scanner does not fully scan.** Recommended: the
   provider intersection rule above, applied to scoped and full requests alike,
   then send expectations. Interim behaviour is unfenced, explicitly labelled
   rather than silently weaker. A caller-side skip filter is rejected.
3. **Dirty binding.** Recommended: `canonical_binding: 'dirty'` with expectations
   once the skip rule is released, and no identity. The alternative — refusing
   demand indexing on a dirty checkout — breaks #346 U10 and is rejected.
4. **Unadmitted Goal.** Recommended: index unbound and record
   `goal_unadmitted`; a Goal binds only after admission, and re-pinning on
   `rebaseStaleBase` is a separate follow-up. The alternative — refusing
   `code_index` until a re-pin exists — creates a permanent outage for Goals
   created without a live pin, because `pinGoalBaseAtCommit` is allowed to skip.

## Rollout order

1. This repo: parse the existing handshake flags into the typed handshake. No
   behaviour change, no fingerprint change.
2. thai-rag-mcp: the skip-aware intersection rule plus `unfenced_paths`, for both
   scoped and full requests.
3. This repo: resolver, workspace plumbing (`lifecycleKind`/`goalId`,
   `dirtyState`), adapter wiring, tests. No expectations are sent until step 2 is
   released; then scoped expectations, then full expectations.
4. *(landed 2026-11-07)* Goal re-pin on `rebaseStaleBase` so an advanced base
   can bind again: after the completion receipt is durable, the service
   re-pins the overlay at the new base commit through the existing admission
   port and reports `pinned` / `skipped` / `failed` on `REBASED`. A skip is
   ordinary — the live canonical ref may not have advanced to the new base
   yet — and a store failure never downgrades a completed rebase. The guarded
   rebase itself is not yet exposed as an MCP operation, so the re-pin becomes
   observable when that surface lands; a drifted Goal still indexes unbound and
   records `goal_unadmitted` until then.
5. *(landed 2026-11-07)* Route `startWorkspaceAdmissionIndex` through the same
   resolver, so automatic admission generations are anchored too. The trial and
   the delta send the identity and fence, the completed local job records
   `canonical_binding`/`canonical_fence`, and a provider-loss restart drops the
   original anchor instead of claiming it.
6. Make the binding mandatory only after a full local reindex proves every
   canonical workspace resolves; until then an unanchored pass is allowed but
   recorded.

## Non-goals

- No Git resolution inside Thai-RAG. Unified reuses its existing origin-remote
  reader only to select the ref; the provider still owns no Git.
- No new contract fingerprint and no new capability string.
- No second base+overlay merge; `resolveGoalLogicalView` stays the one owner.
- No schema migration: the manifest store already carries every field, and the
  new verification fields are optional so existing `schemaVersion: 1` records
  keep parsing.
- No change to GC, admission, leases or the maintenance cycle.
- No automatic Goal overlay re-pin outside a guarded rebase; a creation-time
  skip keeps indexing unbound (`goal_unadmitted`) until a `rebaseStaleBase`
  re-pins it at a live base.
- No WebUI projection here; §11 owns that.

Refs #210.
