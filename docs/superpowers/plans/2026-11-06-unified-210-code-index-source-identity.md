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
}): Promise<CanonicalSourceIdentity | null>
~~~

The caller passes the exact ref it means to bind, derived the same way the rest
of the runtime derives it (`resolveGoalBaseBranch(rootPath)` +
`canonicalRefForBranch(defaultBranch)`), so the resolver never scans the store
or picks among refs.

- **Plain checkout.** Strict-read the named ref and its manifest. The manifest
  `repositoryId` must be in `expectedRepositoryIds`. A missing ref is `null`
  only when this repository could have one at all: with
  `expectedRepositoryIds === null` (no origin) no canonical ref can ever be
  bound, so the resolver returns `null` and the pass records `absent`.
- **Goal workspace.** Admission requires the overlay base to equal the live ref
  (`verifyGoalAdmission` refuses any drift), so a Goal whose main moved must
  re-pin rather than be indexed against a stale base. Run
  `verifyGoalAdmission(refs, overlays, { goalWorkspaceId, canonicalRef })`, use
  its returned `baseManifestId`, and treat `admitted: false` as an error.

It returns exactly the provider fields, all from the selected manifest/ref:

~~~ts
{
  repository_id,      // manifest.repositoryId
  manifest_id,        // man:v1:… (the admitted Goal base)
  revision_id,        // rev:v1:…
  commit_sha,
  tree_oid,
  ref,                // canonicalRef
}
~~~

`null` is only "this repository has never promoted a canonical ref". Every other
state is an error, not a quiet null: a null repository id is the no-origin case
above, while a foreign manifest, a corrupt or dangling record, and a failed Goal
admission all refuse. Reads are strict (`CanonicalRefStore.read(ref, { strict:
true })`, `CanonicalManifestStore(..., { strictReads: true })`) so a corrupt
store is reported instead of being read as "never promoted".

### 2. Send it only for a view the revision actually describes

The adapter owns this decision, not the resolver: it already collects
`WorkspaceSourceEvidenceIdentity` (head, dirty and staged fingerprints) for
admission, and compares that to the resolver's `commit_sha`.

`source_identity` claims "these bytes are revision M". Send it only when that is
true:

- a clean checkout whose HEAD is the manifest commit, or
- a Goal workspace whose admission-verified logical view is the source indexed.

A dirty plain checkout is not representable: the revision does not contain its
uncommitted bytes, and the identity schema has no dirty marker. That request
carries expectations only (next section) and records `canonical_binding: 'dirty'`;
it never attaches revision M to bytes it does not contain. Untracked additions in
a scoped request are the same case.

`canonical_binding` is a Unified-side field in the index result and job ledger —
operator-facing state, never sent to the provider, whose identity validator would
refuse an unknown field. Every identity field comes from the ref/manifest record.
`WorkspaceSourceEvidenceIdentity` may decide *whether* to send, but never supplies
a binding field: its `repositoryIdentity` is admission evidence, not
`repository_id`.

### 3. Fence the bytes this call asks for

For a Goal workspace, do not re-derive the merge: `resolveGoalLogicalView(refs,
overlays, …)` already verifies admission and applies overlay-over-base with
tombstones removed. Reuse it, and read the overlay entries separately for
`deleted_paths` (a tombstone is a declared removal and must not appear in
`expected_paths`).

**Scoped request (`paths`).** An expectation is the hash of the byte the caller
believes it is publishing: the effective-view hash (overlay or manifest) for a
tracked, unmodified path, the live content hash for a dirty or untracked path. A
requested path that exists nowhere — neither on disk nor in the view — is refused
before the child call.

**Full request (no `paths`).** The manifest is every leaf of the Git tree, while
the provider's scanner deliberately skips `gitignored`, `hidden`, `sensitive`,
`binary`, `too_large` and other reasons (`thai_rag/source_scanner.py`,
`_SKIP_REASONS`). Sending the whole map today would make an ordinary full pass
`stale_index` on every skipped path. Full-run fencing therefore needs one
provider rule, landed before Unified sends a full map:

> an expectation is a violation only when the path was scanned and its hash
> differs, or when the path is absent from disk; a skipped-but-present path is
> reported as `unfenced_paths`, not as stale.

Until that rule exists, a full pass sends no expectations and records
`canonical_binding: 'recorded'`: the manifest id is recorded but the bytes are not
fenced. Do not substitute a caller-side filter for this — matching the provider's
skip policy in Unified would be a second, drifting copy of it.

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

Flags absent → omit identity and expectations, and record `canonical_binding:
'absent'`.

### 5. What must not change

- `paths`/`max_files` semantics and admission stay exactly as they are.
- The resolver never writes, promotes or repairs a ref.
- A workspace with no canonical ref — including a checkout with no origin, which
  can never have one — keeps indexing and records `absent`.
- `canonical_binding` stays a Unified-side result field; the provider sees only
  `source_identity`, `expected_paths` and `deleted_paths`.
- The provider remains the only owner of semantic artifact identity; Unified
  sends source truth only.

## Test matrix

Unified side:

- `codeIndex()` forwards `source_identity` byte-for-byte for a clean checkout with
  an active manifest (regression shape of the dropped `paths` bug, #346 U10);
- a workspace with no canonical ref, and a checkout with no origin, send no
  `source_identity`, still index, and record `absent`;
- a corrupt ref read, a dangling manifest, a foreign `repositoryId` and a failed
  Goal admission are refused, never the quiet null;
- a Goal workspace is admitted only while its pinned base equals the live ref;
  drift refuses and the Goal must re-pin, and the admitted base manifest is bound;
- a scoped request sends the effective hash per path; a dirty path uses the live
  content hash; a tombstone becomes `deleted_paths` and never `expected_paths`;
- a requested path that exists nowhere is refused before the child call, and
  nothing is sent;
- a dirty plain checkout sends expectations without `source_identity` and records
  `canonical_binding: 'dirty'`;
- a full request before the provider rule sends no expectations and records
  `'recorded'`; after it, sends the complete map and a moved path refuses with
  `stale_index`;
- `stale_index` and `invalid_input` pass through unchanged with their payloads;
- the gate: flags absent → `'absent'`; flags present → identity and expectations;
- `canonical_binding` never appears in the child arguments;
- the existing conformance fixture still validates: this slice changes no
  fingerprint.

Provider side (follow-up in thai-rag-mcp):

- the scoped fence is unchanged;
- the full-run intersection rule reports skipped-but-present paths as
  `unfenced_paths` and still refuses an absent path as stale;
- an unchanged revision reuses the recorded anchor across a restart.

## Open decisions

1. **Which ref is this checkout's?** The store is store-wide, so the caller names
   the ref explicitly (`resolveGoalBaseBranch` + `canonicalRefForBranch`) and the
   resolver validates its manifest against `expectedRepositoryIds`. Recommended:
   this explicit ref, never a scan of store refs. A checkout with no origin has
   `expectedRepositoryIds === null`, can never match, and records `absent`.
2. **Full-run fencing.** Recommended: the provider intersection rule above, then
   send the complete map. Interim behaviour is recorded-but-unfenced, explicitly
   labelled rather than silently weaker.
3. **Dirty binding.** Recommended: `canonical_binding: 'dirty'` with expectations
   and no identity. The alternative — refusing demand indexing on a dirty
   checkout — breaks #346 U10 and is rejected.

## Rollout order

1. This repo: parse the existing handshake flags into the typed handshake. No
   behaviour change, no fingerprint change.
2. thai-rag-mcp: the full-run intersection rule plus `unfenced_paths`.
3. This repo: resolver, adapter wiring, scoped expectations, tests; enable full
   expectations only after step 2 is released.
4. Make the binding mandatory only after a full local reindex proves every
   canonical workspace resolves; until then an unanchored pass is allowed but
   recorded.

## Non-goals

- No Git resolution inside Thai-RAG. Unified reuses its existing origin-remote
  reader only to select the ref; the provider still owns no Git.
- No new contract fingerprint and no new capability string.
- No second base+overlay merge; `resolveGoalLogicalView` stays the one owner.
- No schema migration; the manifest store already carries every field.
- No change to GC, admission, leases or the maintenance cycle.
- No WebUI projection here; §11 owns that.

Refs #210.
