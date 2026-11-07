# Plan: harden index-job error redaction (#210 follow-up)

## Context

PR #685 made `rag_index_job_list` terminal error text identity-safe at the MCP
projection boundary. Its exact-head review left two nonblocking findings, both
in `apps/cli/src/runtime/index-job-history-projection.ts`:

1. the quoted-path rule stops at the first quote character, so a quoted path
   containing an apostrophe (`open '/home/O'Brien/x.ts'`) keeps the tail after
   the placeholder, and colon-adjacent absolute forms (`path:/home/...`,
   `file:/home/...`) are not matched by the POSIX rule;
2. the `sanitizeIndexJobError` doc comment says placeholders are applied before
   control characters are collapsed, while the implementation collapses first.

Neither form was demonstrated reachable from the provider error formats on
main, so this is a hardening slice, not a production-leak fix.

## Change

- Replace the quoted-path rule with a boundary-aware form that:
  - only starts at a quote preceded by start, whitespace, `=`, `(`, `[`, `{`,
    `,`, `;` or `:`, so an apostrophe inside a word does not start a match;
  - allows a same-character quote inside the content when it is not followed
    by a token boundary, so `O'Brien` stays inside the same quoted path;
  - still preserves safe URLs and exact Git refs.
- Extend the POSIX absolute rule to accept `:` as a prefix (catching
  `path:/home/...` and `file:/home/...`) and `~/` as a home-relative token.
- Correct the doc comment to state the real order: collapse control/whitespace,
  then redact, then bound to 400 characters.
- Add regression tests for an internal apostrophe, a prose apostrophe that must
  not start a match, colon-adjacent absolutes, the single-slash `file:` URI
  form, and `~/` paths. Keep the existing URL/Git-ref preservation assertions.

## Verification

- `corepack pnpm@10.15.0 --filter @unified-mpc/cli test -- src/runtime/index-job-history-projection.test.ts`
- `corepack pnpm@10.15.0 typecheck`
- `corepack pnpm@10.15.0 lint`
- `corepack pnpm@10.15.0 verify:local` on the exact head
- exact-head independent review, then guarded merge

## Boundaries

- Only the MCP projection boundary changes. The durable ledger, CLI
  `index job list --json` output and WebUI failure projection keep raw text.
- No change to provider persistence or error-message construction.
