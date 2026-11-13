# Thai-RAG provider contract v1

Normative, machine-checked description of the boundary between Unified MCP and
the Thai-RAG provider (issue #1). Unified is the public surface; this repository
is the engine behind it. The contract is the only thing both sides may depend
on: no caller parses log lines, reads storage internals, or infers provenance
from transport.

| File | Role |
| --- | --- |
| `provider-contract.v1.schema.json` | JSON Schema (draft 2020-12) for one result envelope plus the request-side definitions. |
| `fixtures/*.json` | Complete `ProviderResult` envelopes for the states both sides must agree on. |
| `fixtures/index.json` | Corpus manifest: which fixture proves which state, and the expected status/error codes. |
| `examples/index-request-*.json` | Canonical `code_index` request subsets for native and standalone mode. |
| `../tests/test_provider_contract_schema.py` | Keeps the artifact honest against the live Python provider. |

## 1. Authority split

The same semantic core runs behind two control adapters. Only source truth
differs; artifact identity, chunking, embedding and publication never fork.

```text
Unified native mode                      Standalone mode
-------------------                      ---------------
Unified owns Git/ref/tree truth          Local Git/filesystem truth
Unified mints man:v1 manifest ids        Provider mints lman:v1 manifest ids
Unified sends source_identity            Provider resolves its own revision
Unified sends expected_paths fence       Provider scans and fences locally
        |                                         |
        +------------ same semantic core --------+
```

Rules:

1. In native mode Unified is authoritative for `repository_id`, `ref`,
   `commit_sha`, `tree_oid` and `manifest_id`. The provider verifies and
   records them; it never silently resolves a different canonical ref.
2. A canonical `man:v1:...` id can only be satisfied by the tree Unified
   described. A local `lman:v1:...` id is a different authority and is refused
   where a canonical id is required.
3. In standalone mode `source_identity` is absent and the local revision adapter
   owns source truth. A standalone result must never claim canonical identity.
4. The workspace boundary is always the exact canonical `workspace_id`. A
   basename, path suffix, category or inferred namespace is not authorization.
5. The adapter that owns source truth declares its authority; the engine never
   infers it from transport or tool presence. An adapter declares
   `control_mode` as `unified_native` (the Unified native worker sets
   `THAI_RAG_CONTROL_MODE=unified_native`), `standalone_git` when it drives the
   local Git revision adapter, or `standalone_snapshot` when nothing is
   declared. `source_authority` is derived from the declared mode:
   `unified_canonical_manifest`, `local_git_revision`, `local_filesystem`. The
   declaration is validated once when the core starts, so an unknown value fails
   fast. An explicit `ThaiRagProvider(control_mode=...)` wins over the
   environment; an unset or blank environment variable means "not declared",
   and an explicitly supplied blank value is refused.

## 2. Versioning

- `contract_version` is `1.0`. The schema file is `v1`; a breaking change ships
  as `provider-contract.v2.schema.json` and a new `contract_version`.
- `contract_fingerprint` is the SHA-256 of the canonical JSON of the operation,
  status, scope and capability shape defined in `thai_rag/provider.py`. A
  consumer records the fingerprint from `version()`/`health()` and refuses a
  peer whose fingerprint or `compatibility_range` it does not support.
- Within `v1`:
  - **Closed to addition, removal or rename:** the result envelope key set,
    `ProviderStatus`, `source_identity`, the request definitions, `readiness`
    and `generation_compatibility`. The schema rejects extra result keys, and
    `ProviderStatus` is inside the fingerprint, so a new value moves it. Any of
    those changes ships as `v2`.
  - **Open to addition: `ErrorCode`.** The vocabulary may gain values inside
    `v1`. A new code names a state the provider could already reach; refusing
    it adds no safety, only a version barrier that blocks a rollout. `ErrorCode`
    is deliberately outside `contract_fingerprint`, so adding a value does not
    move the fingerprint.
  - **Consumer obligation for `ErrorCode`.** Switch on the values you know and
    treat an unrecognised value as a terminal failure of that operation, unless
    the envelope sets `details.retryable: true`: retryability comes from that
    flag, never from the code. Do not crash, do not require the enum to be
    exhaustive, and do not reject a result because the code is unrecognised.
    Validation must reject an unknown *shape*, never an unknown *code*. A provider still cannot rely on a new code being understood:
    if a code changes what the caller should do next, that is a breaking change
    and belongs in `v2` as a new status or a new operation.
  - **Open fields:** `data`, `metadata` and `embedding` may add fields. A
    consumer must ignore unknown keys there and must not require them.

### How a consumer vendors the schema

1. Copy the schema and the fixture corpus at a pinned commit; do not hand-edit
   either.
2. On handshake, require `provider_name == "thai-rag"`, a supported
   `contract_version`, and a `contract_fingerprint` you have tested.
3. Validate every provider result against the envelope before acting on it, with
   one deliberate exception: the vendored `error_code` enum must not be able to
   reject a result. Validate a copy of the schema whose `$defs/error_code` is
   `{"type": "string"}`, or validate the result and downgrade exactly that one
   violation. Every other mismatch stays a contract break. The enum is the
   vocabulary you were tested against, not an exhaustive gate; rejecting a code
   outside it turns an additive provider change into an outage.
4. Run the fixture corpus against your adapter. A fixture that fails unchanged
   is a contract break, not a test to update.

`python -m pytest tests/test_provider_contract_schema.py -q` is the reference
validation; `jsonschema>=4,<5` is the only added dependency.

## 3. Result envelope

Every operation returns exactly these keys (see `$defs/provider_result`). A
missing key is a contract violation, not an omission.

| Key | Type | Meaning |
| --- | --- | --- |
| `status` | `ok \| review_required \| degraded \| unavailable` | What the caller may do next. |
| `data` | any | Operation payload. Open within `v1`. `null` when the operation failed before producing one. |
| `workspace_id` | string \| null | Echo of the requested canonical workspace, or `null` when none was supplied. |
| `repository_id` | string \| null | Canonical repository identity. Only claimed when the core recorded it or the workspace provenance resolved. |
| `revision_id` | `rev:v1:<64hex>` \| null | Canonical revision identity, when one was recorded. |
| `artifact_id` | string \| null | Immutable artifact reference, when the operation resolved one. |
| `repository_provenance` | `git-common-dir:sha256:<64hex>` \| null | Local trust boundary shared only by Git worktrees. Never a path or remote URL. |
| `trust_scope` | string \| null | `workspace` when provenance resolved, `repository_provenance_unverified` otherwise. |
| `operation_id` | string \| null | Correlation id, when the caller supplied one. |
| `generation` | string \| object \| null | Generation identity, when the operation reports one. |
| `warnings` | string[] | Non-fatal degradations. `code_index` lifts `data.warnings`; `health()` reports its own readiness warnings in the same field. |
| `errors` | `{code, message, details}[]` | Typed failures. `message` is for humans; `code` is the switch. |
| `metadata` | object | Handshake: provider/contract versions, fingerprint, compatibility range, generation, embedding profile, readiness. |

Identity carry-through rules:

- `code_index` echoes the identity the core recorded in `data.source_identity`
  and lifts `repository_id`/`revision_id` from it. An error or a core without
  identity support claims nothing.
- `health()` and `version()` never claim repository or revision identity; their
  job is the handshake.
- A trust boundary failure yields `repository_provenance: null` and
  `trust_scope: "repository_provenance_unverified"`; it never guesses.

## 4. Canonical index request

`$defs/canonical_index_request` pins the source-bearing subset of `code_index`.
Other options (`force`, `background`, `dry_run`, `max_files`, `vectors`, ...)
keep their existing provider semantics and are outside schema `v1`.

### `source_identity` (required in native mode, absent in standalone)

Closed object. Unknown fields are refused, because Unified sends this block
byte-for-byte and a renamed field must not be silently dropped.

| Field | Required | Rule |
| --- | --- | --- |
| `repository_id` | yes | Non-empty, no NUL. Unified's canonical repository identity. |
| `manifest_id` | yes | `man:v1:<64hex>`. Unified mints it from the tree it observed. |
| `revision_id` | no | `rev:v1:<64hex>`. |
| `commit_sha` | no | 40- or 64-hex Git object id. |
| `tree_oid` | no | 40- or 64-hex Git object id. |
| `ref` | no | `refs/...`, no `..` segment. |

### `expected_paths`

Mapping `repo-relative path -> exact 64-hex SHA-256` of the byte the scanner
will read. Paths are forward-slash, relative, with no `..`, empty or trailing
segment, no backslash and no NUL; a leading `./` is normalized before
validation. Two spellings of the same normalized path must carry the same
hash; a disagreement is refused instead of resolved by last-write-wins.

Unified derives the view from the effective logical state and never declares a
hash the worktree already contradicts:

```text
effective view = admitted Goal overlay over base manifest, minus tombstones
for each path in view or requested scope:
    declared removal            -> deleted_paths, not expected_paths
    live bytes == view hash     -> expected_paths[path] = view hash
    live bytes != view hash     -> expected_paths[path] = live hash, report drift
    live file the view lacks    -> expected_paths[path] = live hash, report drift
    view path absent from disk  -> deleted_paths, report drift
    symlink/unreadable/escaping -> omit from both fences
```

A tracked path absent from disk is never an expectation: the scanner cannot
observe bytes for it. A requested path that exists nowhere is refused before
the provider call instead of being declared as a deletion the caller never
owned.

### `deleted_paths`

Sorted, unique, normalized repo-relative paths the caller's revision no longer
contains. This is a declaration, not a fence: the provider hides the path even
when a copy still exists in the checkout, and hiding is reversible. Declaring
the same path both deleted and expected is refused.

### `paths`

Optional scope. Entries are validated like fence paths and normalized (a
leading `./` is removed); a bare string is refused instead of being iterated
character by character, and duplicate spellings collapse to one path. The
provider fences only requested paths; unscoped paths are carried forward from
the active generation. Without `paths`, every expectation is fenced.

### Fence outcomes

| Observation | Result |
| --- | --- |
| every scoped expectation matches | index proceeds; identity recorded |
| expectation mismatches live bytes | `review_required` + `stale_index`; nothing published |
| expected path was skipped by policy but exists on disk | reported in `data.unfenced_paths`, not stale |
| declared removal | honored as a tombstone, no fence |
| path both expected and deleted | `invalid_input` before any job or staging row |

The provider validates the identity, fence and scope fields above at its own
boundary, before the core is called or any job/staging row exists, and forwards
only the normalized form: trimmed identity strings, lower-cased ids and hashes,
and paths without a leading `./`. A malformed request is `invalid_input` even
when the injected core is too old to record canonical fields. A core without
identity support still returns `ok` without recording it; as in §3, the
envelope then claims no `repository_id`/`revision_id` rather than echoing what
the caller sent.

`stale_index` means "re-resolve your revision and re-request", not "provider
outage". The provider never repairs the caller's identity.

## 5. Status and error semantics

`status` is the consumer's decision, not a severity label:

| Status | Meaning | Caller action |
| --- | --- | --- |
| `ok` | Requested work completed. | Use `data`. |
| `review_required` | Input no longer describes source truth. | Re-resolve identity, re-request. Do not retry unchanged. |
| `degraded` | Usable result with a named capability missing. | Use with the warning; optionally repair. |
| `unavailable` | No usable result. | Read `errors[].code`; retry only if `details.retryable`. |

Stable error vocabulary (`$defs/error_code`):

| Group | Codes |
| --- | --- |
| Input/scope | `invalid_input`, `workspace_scope_required`, `workspace_not_found`, `scope_denied` |
| Memory | `memory_not_found`, `memory_reconciliation_pending` |
| Storage/retrieval | `storage_unavailable`, `lexical_retrieval_unavailable`, `vector_retrieval_degraded` |
| Embedding | `embedding_unavailable` |
| Index identity | `stale_index`, `incompatible_index`, `indexing_conflict`, `index_job_not_found` |
| Control | `cancellation`, `internal_failure` |

Selected mappings the corpus pins:

| Situation | Status | Code |
| --- | --- | --- |
| stale canonical expectation | `review_required` | `stale_index` |
| foreign/unregistered workspace | `unavailable` | `scope_denied` |
| caller demands a generation the active index cannot satisfy | `unavailable` | `incompatible_index`, `details.reason: "base_generation_not_active"` |
| `sqlite3.OperationalError: database is locked` | `unavailable` | `storage_unavailable`, `details.retryable: true`, `details.reason: "sqlite_busy"` |
| embedding backend down, lexical still works | `degraded` | `embedding_unavailable` |
| index slot already occupied | `unavailable` | `indexing_conflict`, `details.job_id` names the active job |
| job lost to a restart or retention expiry | `unavailable` | `index_job_not_found`, `details.reason: "provider_restart_or_retention_expiry"` |
| job cancelled | `ok` envelope, `data.status: "cancelled"` | none; job state is data |

`index_status` reports job state in `data.status`; only an unknown or
out-of-scope job becomes a typed error. An unresolved job id is
`index_job_not_found`, not `workspace_not_found`: the workspace scope was
proven and only the job is gone (restart, retention expiry, or another provider
instance owns it). `workspace_not_found` stays reserved for an unresolvable
workspace scope.

## 6. Generation compatibility

`metadata.generation` answers "is this generation current for the caller?"
without reading storage internals:

| Field | Identity |
| --- | --- |
| `contract` | Contract fingerprint. |
| `embedding` | Embedding profile id (model-specific). |
| `index` | Embedding index generation / preprocessing generation. |
| `storage` | Storage engine identity. |

A caller that requires a specific generation is answered with
`incompatible_index` when that demand cannot be honoured. `attach_workspace_base`
is the canonical demand point: it pins one base generation, so a generation
that is no longer that workspace's active view is `unavailable` with
`details.demanded_generation_id`, `details.active_generation_id` and
`details.reason: "base_generation_not_active"` — not `invalid_input`, because
the request is well-formed. Current indexing instead rebuilds for a changed
embedding profile rather than rejecting the request (see §8). A generation is
never silently reused across a contract, embedding-profile or index-generation
change. `code_search` follows the same rule: when the caller requests hybrid
evidence and the active generation was published by another embedding profile,
the provider answers from the channel it can trust and names the missing vector
channel in `warnings` instead of scoring mismatched vectors. A strong lexical
answer that never requested the vector half stays `ok`. File and revision
identity stay independent of embedding identity: re-embedding must not rewrite
revision ids, and a revision change must not invalidate vectors whose content
hashes and profile still match.

## 7. Fixture corpus

`fixtures/index.json` is the manifest. Each fixture is a complete envelope and
asserts its status, error codes and selected `data` fields. A fixture with
non-null `data` names a `data_schema` under `$defs`; the test suite validates
that payload, so the corpus machine-checks the operation fields it describes
without closing `data` against additive fields.

Every fixture's `metadata` version fields (`contract_version`,
`provider_version`, `contract_fingerprint`, `compatibility_range`,
`index_job_contract_version`, `generation.contract`) are pinned to the live
provider constants. A contract change that bumps any of them must update the
corpus in the same commit; `test_fixtures_match_the_live_contract_constants`
fails otherwise.

The same corpus is replayed on both surfaces this repo serves directly.
`tests/test_provider_fixture_replay.py` drives one scripted core per fixture
into the direct `ThaiRagProvider` and checks the declared status, error
codes/details and pinned `data` fields, then validates the live envelope and
operation payload against this schema.
`tests/test_standalone_adapter_fixture_replay.py` replays the identical
scenarios through the standalone FastMCP tool wrapper and requires the adapter
payload to equal the provider envelope, allowing only the additive
`presentation` key on a successful code tool. Both replays share their scenarios
from `tests/contract_replay.py`, so the surfaces cannot drift apart. Every
fixture must own a replay scenario, so a new state cannot be added as a document
that nothing executes. The corpus therefore describes provider behavior, not
only the fixtures themselves. The Unified-native adapter half of the
shared-fixture deliverable stays with Unified's own suite.

The same scenarios also cross the real data-owner process boundary:
`tests/test_provider_boundary_fixture_replay.py` runs an owner subprocess, calls
it through `_ForwardingProvider` exactly as a standalone follower does, and
requires the rehydrated envelope to equal the direct provider result and the
fixture declaration. A field that survives in-process but not the IPC JSON
round-trip fails here.

| State | Operation | Proves |
| --- | --- | --- |
| `ready` | `health` | full handshake and capability flags |
| `degraded-embedding` | `health` | lexical-only degradation is `degraded`, not failure |
| `unavailable-storage` | `health` | every channel down is `unavailable` with typed errors |
| `indexing-conflict` | `code_index` | a second job names the active job instead of queueing silently |
| `workspace-scope-denied` | `code_search` | canonical scope is authorization |
| `code-search-success` | `code_search` | a successful search pins query, items, rescue diagnostics and warnings |
| `incompatible-index` | `attach_workspace_base` | a well-formed demand for an inactive generation is `incompatible_index`, not `invalid_input` |
| `attach-success` | `attach_workspace_base` | a successful attach pins the base reference and identity |
| `zero-change-verification` | `code_index` | an all-unchanged delta reuses the active generation and echoes identity |
| `lexical-only-index` | `code_index` | lexical-only publication is `ok` with a named warning and `vectors_skipped:disabled` channel |
| `stale-source` | `code_index` | stale fence is `review_required`, nothing published |
| `job-lost-after-restart` | `index_status` | a lost job is a typed error with the restart reason, not a fake status |
| `cancelled-job` | `index_status` | cancellation is job data with requested/completed flags |
| `typed-provider-failure` | `code_index` | sqlite busy carries `retryable` and `reason` |

## 8. Known gaps in contract 1.0

These are documented so a consumer does not infer them from the schema.
`control_mode` and `source_authority` are no longer gaps: the adapter declares
its authority as described in §1 rule 5. A native deployment only reports
`unified_native` once its adapter declares it; until then the standalone
default is the honest answer, and `source_identity` presence remains the
stronger signal during that rollout.

1. `data` is open in `v1`. The corpus machine-validates every non-null payload
   it carries (`health`, `code_index`, `index_status`, `code_search`,
   `attach_workspace_base`), but the envelope does not dispatch `data` by
   operation for consumers.
2. Envelope `repository_id`/`revision_id` are claimed only when the core records
   a `source_identity`; they are not synthesized from `data` fields the provider
   cannot verify.
3. `incompatible_index` is emitted only where a caller actually demands one
   generation: `attach_workspace_base` refuses a generation that is not the base
   workspace's active view (§6). Indexing still rebuilds for a changed embedding
   profile instead of rejecting the request, and operations that merely read the
   active index do not take a generation demand. Do not treat the absence of
   this code as proof of compatibility — compare `metadata.generation` yourself.

Closing any of these requires a contract review because a consumer may already
depend on the current truthful behavior.
