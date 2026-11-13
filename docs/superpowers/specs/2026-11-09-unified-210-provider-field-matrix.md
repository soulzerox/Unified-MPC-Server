# Unified ↔ Thai-RAG provider field matrix (#210 §1, §13)

Status: published. The vendored schema is the authority; this document records
which side owns each field, the exact shape Unified sends, and the fields that
must never cross the boundary.

Sources of truth:

| Source | What it pins |
| --- | --- |
| `packages/thai-rag/contract/provider-contract.v1.schema.json` | Machine-readable request/result shapes (vendored, sha256-pinned) |
| `packages/thai-rag/contract/README.md` | Normative field semantics |
| `apps/cli/src/runtime/native-thai-rag-provider.ts` | The exact object Unified sends (`canonicalChildArgs`) |
| `packages/workspace/src/canonical-source-identity.ts` | Unified's `CanonicalSourceIdentity` |
| `packages/workspace/src/canonical-source-expectations.ts` | Fence derivation from the effective logical view |

## 1. Ownership split

```text
Unified (authoritative)                 Thai-RAG (validates + records)
-----------------------                 ------------------------------
repository_id                           shape validation only
manifest_id (man:v1)                    refuses unknown/malformed fields
revision_id, commit_sha, tree_oid, ref  records the identity byte-for-byte
expected_paths (content hashes)         compares against live bytes
deleted_paths (tombstones)              hides declared removals
paths / mode / priority                 scopes the index work
                                        repository_provenance (derived locally)
                                        trust_scope (derived locally)
                                        generation + embedding (handshake)
```

Unified never asks the provider to resolve a ref, commit or manifest. Thai-RAG
never derives, reinterprets or repairs Unified identity; Native mode reports
`source_authority: unified_canonical_manifest` and validates what it was given
(PR #698 / thai-rag-mcp #428).

## 2. Request fields

`$defs/canonical_index_request` is the pinned subset of `code_index`. Other
options (`force`, `background`, `dry_run`, `max_files`, `vectors`, ...) keep
their existing provider semantics and are outside schema v1.

| Field | Sent by Unified | Shape | Required | Rule |
| --- | --- | --- | --- | --- |
| `workspace_id` | always | string | yes | Canonical workspace id; the only required key |
| `source_identity` | Native mode, only when the canonical binding resolves to `bound` | closed object | no (schema requires only `workspace_id`) | See §3. Omitted in standalone and in Native whenever the binding is `absent`, `dirty`, `goal_unadmitted` or `unsupported`: a run that cannot claim a revision must not publish one |
| `expected_paths` | when the view has tracked bytes | object | no | repo-relative path → exact 64-hex SHA-256 |
| `deleted_paths` | when the revision removed paths | string[] | no | sorted, unique, normalized; never overlaps `expected_paths` |
| `paths` | scoped index requests | string[] | no | Same path rules as the fence; duplicates collapse |
| `mode` | delta/full | `"delta" \| "full"` | no | `delta` for incremental admission; `full` forces a rebuild |
| `priority` | optionally | `"blocking" \| "background"` | no | Provider queue class |

### Path rules (shared by `expected_paths`, `deleted_paths`, `paths`)

Forward-slash, repository-relative, no `..`, no empty or trailing segment, no
backslash, no NUL. A leading `./` is normalized before validation. A bare
string is refused rather than iterated character by character.

## 3. `source_identity` (closed)

Unknown fields are refused at the provider boundary, so a renamed field cannot
be silently dropped. Unified sends exactly this object:

| Field | Required | Pattern / rule | Minted from |
| --- | --- | --- | --- |
| `repository_id` | yes | Non-empty after trim, no NUL (`^(?=.*\S)[^\u0000]+$`) | Canonical repository identity |
| `manifest_id` | yes | `^man:v1:[0-9a-f]{64}$` | Unified canonical manifest of the observed tree |
| `revision_id` | no | `^rev:v1:[0-9a-f]{64}$` | Canonical revision id |
| `commit_sha` | no | `^(?:[0-9a-f]{40}\|[0-9a-f]{64})$` | Observed Git commit |
| `tree_oid` | no | `^(?:[0-9a-f]{40}\|[0-9a-f]{64})$` | Observed Git tree |
| `ref` | no | `^refs/(?!.*\.\.)[^\u0000]+$` | Exact ref, never a range or `HEAD~1` |

`lman:v1:` is standalone-only. A local manifest id can never satisfy a request
for a canonical `man:v1:` id.

## 4. Fence derivation (`expected_paths` / `deleted_paths`)

Unified derives the effective view (admitted Goal overlay over the base
manifest, minus tombstones) and never declares a hash the worktree already
contradicts:

```text
for each path in view or requested scope:
    declared removal            -> deleted_paths
    live bytes == view hash     -> expected_paths[path] = view hash
    live bytes != view hash     -> expected_paths[path] = live hash, report drift
    live file the view lacks    -> expected_paths[path] = live hash, report drift
    view path absent from disk  -> deleted_paths, report drift
    symlink/unreadable/escaping -> omit from both fences
```

A mismatch is `review_required` + `stale_index`; nothing is published. A
policy-skipped path that still exists on disk is reported in
`data.unfenced_paths`, not as stale, so Unified does not duplicate the
provider's skip policy.

## 5. Result-only fields (never sent)

| Field | Owner | Meaning |
| --- | --- | --- |
| `repository_provenance` | Thai-RAG | `git-common-dir:sha256:<64hex>` local trust boundary shared only by Git worktrees; never a path or remote URL |
| `trust_scope` | Thai-RAG | `workspace` when provenance resolved, `repository_provenance_unverified` when a trust boundary was attempted but could not be verified, `null` when no trust boundary applies (most `health` results) |

Both are derived locally by the provider. Sending them as inputs would let a
caller claim a trust boundary it does not own. The result envelope requires
both keys, so the corpus test also pins their pairing: a resolved provenance
requires `trust_scope: "workspace"`, and a failed one cannot claim it.

Also Unified-side only, never sent: `canonical_binding`, `canonical_fence`,
`canonical_binding_reason`. They are operator-facing result fields added by
`mergeCanonicalIndexRecord`; the provider's identity validator would refuse
them as unknown input fields.

## 6. Generation and embedding compatibility

There is no `code_index.generation_compatibility` request field. Compatibility
is negotiated through the handshake and the provider's own generation record:

| Signal | Where | Who checks |
| --- | --- | --- |
| `contract_version` | `metadata` / handshake | Unified `validateThaiRagHandshake` |
| `contract_fingerprint` | `metadata` / handshake | Must be a tested fingerprint |
| `compatibility_range` | `metadata` / handshake | Must admit the vendored v1 |
| `generation.{contract,embedding,index,storage}` | `metadata` | Provider reuse key; compare it yourself. `incompatible_index` is emitted only by `attach_workspace_base`, which refuses a generation that is not the base workspace's active view (README §8, `fixtures/incompatible-index.json`) — a changed embedding profile still rebuilds the generation instead of rejecting the request |
| `expectedEmbeddingProfile` / `expectedEmbeddingModel` / `expectedPreprocessingVersion` | Unified-side handshake-validation options | Not sent to the provider: `validateThaiRagHandshake` checks them against the handshake. Contract 1.0 maps to the llama.cpp deployment identity (`embeddinggemma-2-Q8_0`) + preprocessing `1`; the retired `nomic-embed-text-v2-moe` identity survives only as 0.9 bridge metadata (#786) |

The provider records exactly one generation identity per contract/embedding/
index/storage tuple. Unified never reads storage internals to decide reuse.

## 7. Standalone mode

Standalone omits `source_identity`: there is no Unified canonical revision to
claim. The provider mints `lman:v1:` from its own scan and reports the
`source_authority` derived from the adapter's declared control mode:
`local_git_revision` for `standalone_git`, `local_filesystem` when nothing is
declared (`standalone_snapshot`), and `unified_canonical_manifest` in Native
mode. Everything else in the matrix is unchanged; identity carry-through rules
still apply (an error or a core without identity support claims nothing).

## 8. What pins this matrix

| Test | Claim |
| --- | --- |
| `packages/thai-rag/src/provider-contract.corpus.test.ts` — `keeps every published identity inside the closed result contract` | Every fixture publishes exactly the closed result envelope; provenance/trust pairing holds; any `data.source_identity` uses only the six allowed fields with the documented patterns |
| Same file — `keeps the closed source_identity field set aligned with the vendored native example` | The schema's closed field set matches the vendored native example |
| `apps/cli/src/runtime/native-thai-rag-provider.test.ts` — `forwards the exact source identity and live fence for a clean checkout` | Unified sends exactly the six-field `CanonicalSourceIdentity` plus the live fence |
| `packages/thai-rag/src/provider-contract.handshake.test.ts` | Handshake, fingerprint and compatibility validation |
| `packages/thai-rag/src/provider-contract.test.ts` | Error vocabulary and boundary readers |

The vendored corpus is refreshed, never hand-edited: see
`packages/thai-rag/contract/VENDORED.md` and
`pnpm --filter @unified-mpc/thai-rag contract:provenance`.

## 9. Remaining #210 scope

This document closes the "specify and publish the exact fields" bullet only.
Still open on #210:

- bullet 3: standalone revision/manifest control plane (thai-rag-mcp #61)

Bullet 4 is closed by linking the active provider generation to the canonical
manifest it was built from: `ProviderGenerationLedger`
(`packages/workspace/src/provider-generation-ledger.ts`) is read strictly by
artifact GC, revision prune, GC expire and the logical-space projection, so a
live generation's manifest and artifacts cannot be collected. Bullet 5 was
evidenced in #463/#464.

Parent #210 remains open.
