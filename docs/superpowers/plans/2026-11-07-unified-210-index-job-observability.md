# Unified #210 slice — durable index-job observability

Issue: soulzerox/Unified-MPC-Server#210 (§11 observability)
Depends on: `ThaiRagIndexJobStore` (durable provider job ledger), `index status`
(#623), `index revision list` (#625), `rag_index_status` / `rag_cancel_index`.
Status: plan-first, red-first implementation in this slice.

## Why this slice now

The two canonical read models answer the revision half of §7:

- `index revision list` answers *what revisions exist and what still holds
  each of them*;
- `index status` answers *what is active, is the store consistent, and which
  refs/overlays/pins block retention*.

The provider half of §11 has no read surface at all. `ThaiRagIndexJobStore`
already persists the exact facts §11 asks status to distinguish — cache hits
and misses by file and chunk, newly embedded files and chunks, miss reasons,
reindex reason, and the terminal failure text — but the only reader is the
runtime owner itself (`get` / `active`), which needs the owner and workspace to
admit work, not to explain history.

`rag_index_status` does not fill the gap: it needs a `jobId` the operator must
already know, and it proxies the *live* provider job. After a provider restart,
a crash, or a completed build, the durable row is the only record, and today an
operator has to open `<dataPath>/thai-rag/index-jobs.json` by hand. That is the
same "the first place an operator learns about it" problem the canonical status
slice fixed for overlays.

## What lands

### 1. Read-only operator listing in `ThaiRagIndexJobStore`

```ts
listForOperator({ workspaceId?, limit? }): Promise<ThaiRagIndexJobListing>
```

The listing is owner-agnostic because an operator is describing the ledger, not
acting as its owner. It is deliberately **not** an ownership bypass: execution
and admission keep using `active(ownerId)` / `get(jobId, ownerId, workspaceId)`,
which still refuse a foreign owner's live row.

The read is genuinely read-only. It hydrates through a private `load()` that
does not `mkdir`, migrate, reap or persist, so a short-lived CLI process cannot
overwrite progress the live runtime owner recorded after the snapshot was read.
`initialize()` keeps every existing mutating behaviour (migration, owner-lost
interruption, stuck-job reaping) for the write/admission path.

Bounding and ordering:

- every active (`running` / `cancelling`) row is listed regardless of `limit`;
- terminal rows are newest-first (`finishedAt`, falling back to `startedAt`),
  bounded to `limit` (default 20, max 200) with a deterministic job-id
  tie-break;
- `matchingRowCount` is the pre-bound match count so a short history is
  distinguishable from a truncated listing;
- `legacy-unavailable` rows are counted, never attributed to a workspace and
  never described with counters they do not carry.

### 2. `unified-mpc index job list [--json] [--workspace <id>] [--limit <n>]`

Operator output names the job, status, workspace, owner, provider job, reindex
reason and timestamps; detail lines print only the counters the row recorded:

```text
jobs 42
shown 3
  idx_umcp_... running workspace <uuid> owner unified-mpc:1 provider idx_... reason explicit_request started <iso> progress <iso>
    files indexed=120 skipped=4 total=700
    cache hit-files=95 hit-chunks=880 miss-files=25 miss-chunks=190 new-files=25 new-chunks=190
    miss-reasons artifact_missing=25
```

Honesty rules:

- absent is not `0`: a metric the row never recorded prints nothing;
- `running` is the persisted status and `progress` the last owner-verified
  write, because the read path does not reap;
- the raw provider `result` payload is not rendered; `--json` prints it;
- `--workspace` accepts only a canonical registration UUID, so a typo is a
  usage error instead of a filter that silently matches nothing;
- a failed job is history, not a store failure: exit `0` for any readable
  ledger, `1` when the ledger cannot be read (never an empty history), `2` for
  usage errors.

### 3. Docs and guard

`docs/CLI_REFERENCE.md` §9 gains the command, its output block and the
read-only/exit-code rules; CLI help lists it; the documented-example guard gains
a semantic expectation and replay dependency so the doc line cannot dispatch
elsewhere.

## Explicit non-goals

- No rename/relink/delete classification: those are revision-delta facts
  (`index revision advance`) and provider-owned artifact identity (§13).
- No mutation: no cancel, retry, prune or reap from the listing.
- No change to `rag_index_status` / `rag_cancel_index`; the MCP tools keep
  their live provider-job contract.
- No WebUI projection; the CLI remains the admin status surface.
- No new persistence format or migration; the ledger schema is unchanged.

## Verification

1. Store unit tests: active-first ordering, terminal bound, workspace filter,
   legacy counting, read-only (no migrate/reap/create/rewrite), corrupt-ledger
   refusal, missing-ledger empty listing.
2. CLI tests: argument parsing (workspace UUID, limit bounds, duplicates,
   unknown flags), operator formatting (present vs absent counters, miss
   reasons, error normalisation, `shown`), dispatch and exit codes.
3. Documented-example replay: `index job list` dispatches exactly once.
4. `verify:targeted` during iteration, then `verify:local` on the exact head;
   exact-head review; guarded merge.
