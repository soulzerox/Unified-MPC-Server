# Unified #210 slice — index-job failure projection and ledger fail-closed

Issue: soulzerox/Unified-MPC-Server#210 (§11 observability, follow-up to #676)
Status: plan-first, red-first implementation in this slice.

## Why this slice now

PR #676 added `unified-mpc index job list`, the first read surface over the
durable Thai-RAG job ledger. Its exact-head review left two nonblocking notes
and the WebUI still has a visible §11 gap:

1. The documented `index job list` example was impossible to produce: it said
   `shown 3` while printing two rows, and printed `legacy-unavailable 0`, which
   the formatter only emits when legacy rows exist.
2. `ThaiRagIndexJobStore.load()` treated any unrecognized document — `{}`, a
   future `schemaVersion: 4`, or a row without a `jobId` — as an empty ledger.
   A read then reported `jobs 0` and exit `0`, and the next runtime write would
   replace the unreadable history with a fresh file.
3. The WebUI job card shows a failed job's `stage` but not its reason. §11
   requires status surfaces to distinguish failures, and the ledger already
   stores the terminal error text.

## What lands

### 1. Ledger reads fail closed

`ThaiRagIndexJobStore.load()` now refuses a document that is not
`schemaVersion` 1–3 with an array `jobs`, and refuses a row that cannot be
parsed. Both throw before any row is committed to the in-memory map, so:

- `listForOperator` rejects and the CLI exits `1` instead of printing an empty
  history;
- `create`/`recordProgress` refuse rather than rewrite a ledger the process
  cannot understand (forward-compatible with a newer runtime's file).

`ENOENT` still means "no ledger yet" and stays a successful empty read.

### 2. WebUI failure and legacy projection

`summarizeRagIndexJobs` returns `{ jobs, legacyRowCount }`; the existing
`parseRagIndexJobs` remains a thin array wrapper. The dashboard payload gains:

- sanitized `error`: control characters and whitespace collapsed, trimmed,
  400-character bound. The raw text stays in the ledger and in
  `index job list`.
- `legacyRowCount`: pre-contract rows are counted once and never attributed to
  a workspace.
- existing active-first ordering is unchanged (active rows newest-first, then
  the newest three terminal rows).

The client renders `· Error: …` on a failed row and names unattributable legacy
rows after the list. No provider payload or result object is exposed.

### 3. Docs

The `index job list` example now matches the formatter: three headline rows for
`shown 3`, and no `legacy-unavailable` line when the count is zero.

## Tests

- Store: unrecognized schema, unknown version and unparseable row each reject;
  the file bytes are unchanged and a subsequent `create` refuses.
- Web: failure text is sanitized and bounded, active rows sort before terminal
  rows, legacy rows are counted not listed, and the endpoint exposes
  `legacyRowCount` while still omitting `providerJobId` and `result`.
- Dashboard: the rendered client script contains the failure and legacy
  affordances.
- Docs: documented-example guard still passes.
