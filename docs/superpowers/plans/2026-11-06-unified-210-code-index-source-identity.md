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

`expected_paths` is `{ repo-relative path: 64-hex content hash }`, `deleted_paths`
is a list whose members must also appear in `expected_paths`. Both require
generation mode, which is the provider default.

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
resolveCanonicalSourceIdentity(rootPath): Promise<CanonicalSourceIdentity | null>
~~~

It reads the active canonical ref with `CanonicalRefStore` and its manifest with
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

Returns `null` — never a partial object — when there is no active ref or the
manifest is missing. A partial binding would be refused by the provider anyway;
deciding it locally keeps the failure at the caller.

### 2. Send it, or send nothing

`codeIndex()` sends `source_identity` only when the resolver returned a value and
the provider handshake advertises the capability (see §4). It never invents
identity from `WorkspaceSourceEvidenceIdentity`: that record is dirty/source
evidence, not a manifest anchor, and its `repositoryIdentity` is a hash of the
Git dir, not `repository_id`.

### 3. Fence the files this call actually asks for

When the request has `paths`:

- look each path up in the manifest;
- a requested path absent from the manifest is refused locally before the child
  call — it cannot be part of the revision being declared;
- send `expected_paths` for exactly those paths, with the manifest hashes.

When the request is full (no `paths`), do not send `expected_paths`: the
provider re-scans the workspace and the manifest id is the anchor.

`deleted_paths` comes from the Goal overlay tombstones for the same scope, read
through `GoalOverlayStore`; a tombstone is a declared removal, not a fence
violation.

### 4. Capability gate, and the cross-repo prerequisite

Add `canonical_source_identity` to the Thai-RAG handshake capability list first
(one-line provider change + handshake test). Unified gates on it:

- capability present → send the binding when resolved;
- capability absent → omit it (today's behavior), and record a warning in the
  index result so an operator can see the workspace is unanchored.

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
- a scoped request sends `expected_paths` for exactly its `paths`, with the
  manifest hashes;
- a requested path missing from the manifest is refused before the child call,
  and nothing is sent;
- overlay tombstones become `deleted_paths`;
- `stale_index` and `invalid_input` pass through unchanged with their payloads;
- the capability gate: absent capability omits the block and records the warning.

Provider side (follow-up in thai-rag-mcp):

- handshake advertises `canonical_source_identity`;
- an unchanged revision reuses the recorded anchor across a restart;
- a moved path refuses publication and leaves the active generation intact.

## Open decisions

1. **Where does `ref` come from?** A manifest row stores `targetRef`, but the
   same manifest can be promoted under several refs. Recommended: send the ref
   the resolver observed as active (`CanonicalRefStore` list), and treat the
   manifest id as the authoritative anchor.
2. **Full-request fencing.** A full request has no `paths`, so no per-file fence.
   Recommended: keep it that way and rely on the provider's pre-activation
   re-scan plus `manifest_id`; sending the whole 695-entry manifest on every full
   pass is the expensive alternative.
3. **Unanchored warning surface.** Recommended: put it in the existing index
   result JSON (`canonical_binding: 'absent'`) rather than a new command.

## Rollout order

1. thai-rag-mcp: capability + handshake test (no behavior change).
2. This repo: resolver, adapter wiring, fence, capability gate, tests.
3. Make the binding mandatory only after a full local reindex proves every
   canonical workspace resolves; until then an unanchored pass is allowed but
   recorded.

## Non-goals

- No second Git resolver in Thai-RAG, and no Git calls from this slice.
- No schema migration; the manifest store already carries every field.
- No change to GC, admission, leases or the maintenance cycle.
- No WebUI projection here; §11 owns that.

Refs #210.
