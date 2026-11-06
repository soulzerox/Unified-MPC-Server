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
Both require generation mode, which is the provider default.

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
  rootPath: string;                          // workspace checkout
  canonicalRoot: string;                     // <dataPath>/canonical
  expectedRepositoryIds: readonly string[];  // this checkout's repository
}): Promise<CanonicalSourceIdentity | null>
~~~

The canonical store is store-wide, not per checkout, and one ref is bound to one
repository, so `rootPath` alone cannot name the binding. The caller derives
`expectedRepositoryIds` with the existing `resolveGoalRepositoryIds(rootPath)`
(the same selector `pinGoalBaseAtCommit` already uses), and the resolver accepts
only a ref whose manifest `repositoryId` is in that set. Zero matching refs or
more than one is refused rather than guessed: the resolver never selects a
binding it cannot attribute to this checkout.

It reads the selected ref with `CanonicalRefStore` and its manifest with
`CanonicalManifestStore`, and returns exactly the provider fields:

~~~ts
{
  repository_id,      // manifest.repositoryId
  manifest_id,        // man:v1:…
  revision_id,        // rev:v1:…
  commit_sha,
  tree_oid,
  ref,                // the ref the manifest was promoted under
}
~~~

`null` means "this repository has no canonical ref" and is the only quiet case. A
ref that exists but whose manifest is missing, unreadable, or bound to another
repository is an error: returning `null` there would turn a dangling ref or a
corrupt store into a silent unanchored index.

### 2. Send it, or send nothing

`codeIndex()` sends `source_identity` only when the resolver returned a value and
the provider handshake advertises the capability (see §4). Every field comes from
the ref/manifest record. `WorkspaceSourceEvidenceIdentity` may help identify
*which* checkout and repository this is, but it never supplies a binding field:
its `repositoryIdentity` is admission evidence, not `repository_id`.

### 3. Fence the files this call asks for — and the ones it does not

Expected hashes are relative to the *effective* source of the checkout, not only
the base manifest: a Goal workspace indexes overlay bytes, so for each path

- overlay entry with a content hash (`modified` or `added`) → use that hash;
- overlay tombstone (`deleted`, null hash) → add the path to `deleted_paths`,
  never to `expected_paths`;
- otherwise → the base manifest hash.

When the request has `paths`, send `expected_paths` for exactly those paths. A
requested path with neither an overlay entry nor a manifest entry is refused
locally before the child call: it cannot be part of the revision being declared.

When the request is full (no `paths`), still send `expected_paths` for every path
the resolver can name (overlay first, base manifest fallback). The provider's
`scope_expected_paths` fences the whole mapping on an unscoped run. Omitting it
would leave `manifest_id` as a recorded declaration only: the provider has no Git
and cannot compare the manifest to the bytes it just scanned, so a full pass could
publish newer content under revision M's identity. Sending every entry is the
price of binding a full pass; if that payload ever becomes a measured problem, the
provider can grow a manifest-digest fence instead of Unified weakening this one.

`deleted_paths` comes from the Goal overlay tombstones for the same scope, read
through `GoalOverlayStore`.

### 4. Capability gate and fingerprint compatibility

The provider declares the capability through its contract shape, and
`CONTRACT_FINGERPRINT` is the hash of that shape. This repo accepts only
fingerprints listed in `SUPPORTED_INDEX_JOB_CONTRACTS`
(`packages/thai-rag/src/provider-contract.ts`), so the provider cannot ship the
capability first without breaking every handshake:

1. this repo adds the new fingerprint entry (and its required-capability set) to
   `SUPPORTED_INDEX_JOB_CONTRACTS` — a no-op while no provider emits it;
2. thai-rag-mcp adds `canonical_source_identity` plus its handshake test;
3. this repo sends the binding only when the handshake lists the capability.
   Absent capability → omit it and record `canonical_binding: 'absent'` in the
   index result, so an operator can see the workspace is unanchored.

This keeps an older provider from refusing every index request with
`invalid_input`, and makes "unanchored" visible instead of silent.

### 5. What must not change

- `paths`/`max_files` semantics and admission stay exactly as they are.
- The resolver never writes, promotes or repairs a ref.
- A workspace with no canonical ref keeps indexing without a binding.
- The provider remains the only owner of semantic artifact identity; Unified
  sends source truth only.

## Test matrix

Unified side:

- `codeIndex()` forwards `source_identity` byte-for-byte for a workspace with an
  active manifest (regression shape of the dropped `paths` bug, #346 U10);
- a workspace with no canonical ref sends no `source_identity` and still indexes;
- a ref whose manifest is missing, unreadable, or bound to another repository is
  refused, not treated as the quiet null case;
- a scoped request sends `expected_paths` for exactly its `paths`;
- overlay-modified and overlay-added paths are fenced with the overlay hash, and
  untouched paths with the base manifest hash;
- overlay tombstones become `deleted_paths` and never appear in `expected_paths`;
- a requested path in neither the overlay nor the manifest is refused before the
  child call, and nothing is sent;
- a full request sends the complete expectation map, and a path moved past the
  manifest refuses publication with `stale_index`;
- `stale_index` and `invalid_input` pass through unchanged with their payloads;
- the capability gate: absent capability omits the block and records the warning;
- the fingerprint gate: an unknown provider fingerprint is still refused, and the
  new fingerprint is accepted only with the required capability set.

Provider side (follow-up in thai-rag-mcp):

- handshake advertises `canonical_source_identity`;
- an unchanged revision reuses the recorded anchor across a restart;
- a moved path refuses publication and leaves the active generation intact.

## Open decisions

1. **Which ref is this checkout's?** A manifest row stores `targetRef`, but the
   same manifest can be promoted under several refs and the store is store-wide.
   Recommended: match on `expectedRepositoryIds` from the checkout's origin and
   require exactly one ref; ambiguity refuses. Never fall back to "the only ref
   in the store".
2. **Full-request fencing.** Recommended: send the complete expectation map, even
   though it is the whole manifest. A recorded `manifest_id` with no fence does
   not bind bytes, and a weaker caller-side rule would only move the hole. If the
   payload becomes measurable, add a provider-side manifest digest.
3. **Unanchored warning surface.** Recommended: put it in the existing index
   result JSON (`canonical_binding: 'absent'`) rather than a new command.

## Rollout order

1. This repo: add the new fingerprint and required capabilities to
   `SUPPORTED_INDEX_JOB_CONTRACTS` (no provider emits it yet; no behavior change).
2. thai-rag-mcp: capability + handshake test.
3. This repo: resolver, adapter wiring, fence, capability gate, tests.
4. Make the binding mandatory only after a full local reindex proves every
   canonical workspace resolves; until then an unanchored pass is allowed but
   recorded.

## Non-goals

- No Git resolution inside Thai-RAG. Unified reuses its existing origin-remote
  reader only to select the ref; the provider still owns no Git.
- No schema migration; the manifest store already carries every field.
- No change to GC, admission, leases or the maintenance cycle.
- No WebUI projection here; §11 owns that.

Refs #210.
