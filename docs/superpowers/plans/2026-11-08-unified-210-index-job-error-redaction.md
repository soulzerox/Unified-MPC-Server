# Unified #210 slice — redact identity from index-job failure text

Issue: soulzerox/Unified-MPC-Server#210 (§11 observability).
Follow-up: the exact-head review draft on PR #683 (head `4545198`) flagged the
leak; the recorded fallback receipt missed it.

## Why this slice now

`rag_index_job_list` promises that provider job ids and raw ledger paths never
reach a tool response:

> Never exposes provider job ids, provider result payloads, owner ids, owner
> process identity or raw ledger paths.

The runtime projection keeps that promise for structured fields — `providerJobId`,
`result`, `ownerId`, `ownerProcessIdentity` and `legacyData` are dropped — but it
forwards terminal `error` text after only collapsing control characters and
bounding the length. That text is not identity-safe:

- `native-thai-rag-provider.ts` persists `errorMessage(error)` for several
  failure paths, and filesystem errors embed an absolute local path
  (`ENOENT: no such file or directory, open '/home/...'`).
- `canonicalSourceInvalid` wraps the same `errorMessage(error)` into the error
  that later reaches `jobs.fail(...)`.
- The lost-provider cancel path interpolates `providerJobId ?? jobId` into the
  persisted message, so a failed or cancelled job can carry the provider id.

A single failed job therefore returns a local path and/or a provider job id
through `rag_index_job_list`, contradicting the tool description.

## What lands

- `sanitizeIndexJobError` redacts identity-bearing substrings before it
  collapses whitespace and applies the 400-character bound:
  - a quoted segment that contains a slash or backslash (a path with spaces),
    unless the segment is a Git ref (`refs/...`) or a URL,
  - `file://` URIs,
  - Windows drive paths and UNC paths,
  - POSIX absolute path tokens (a `/` at the start of a token, never inside a
    URL such as `https://...`),
  - `idx_...` job-id tokens (provider id and the local id alike; the row's own
    `jobId` field is untouched).
- `path` and `job-id` are replaced with the literal placeholders `<path>` and
  `<job-id>`.
- Regression tests cover each token class, a quoted path with spaces, a URL and
  a Git ref that must survive untouched, and a projected failed row that
  combines a path with a provider id.
- No change to the durable ledger, the CLI `index job list --json` output, the
  WebUI failure projection, or any persistence string.

## Non-goals

- Do not change what the runtime persists. Operators keep the full text in the
  local ledger and the CLI, where the path is diagnostic rather than a leak.
- Do not redact Git refs (`refs/remotes/origin/main`), URLs, or ordinary
  `and/or` prose; only absolute local paths and job-id tokens are identity
  bearing.
- No new field, schema, or migration.

## Safety

- Redaction happens only at the MCP boundary (`projectIndexJobHistory`), so the
  CLI and WebUI surfaces are unchanged.
- Over-redaction is preferred to leakage: a false positive loses diagnostic
  detail, a false negative exposes a host identity.
- The existing 400-character bound still applies after redaction, and control
  characters are still collapsed first.

## Verification

- `apps/cli/src/runtime/index-job-history-projection.test.ts` covers the
  sanitizer and the projection row.
- `corepack pnpm@10.15.0 verify:targeted` during development, then
  `corepack pnpm@10.15.0 verify:local` on the exact head before the PR.
