# Plan: close the #705 review follow-ups (#210 follow-up)

## Context

PR #705 merged the vendored Thai-RAG provider contract v1 corpus with a clean
exact-head review. The reviewer recorded three nonblocking findings; this slice
closes them before the next #210 slice so the corpus cannot produce a false
failure on a Windows checkout and the documented refresh path produces the
manifest the test expects.

## Scope

1. Protect the sha256-pinned corpus from line-ending rewriting: add
   `packages/thai-rag/contract/** text eol=lf` to `.gitattributes`.
2. Make the `source_identity` test name and the slice plan tell the truth: the
   corpus test compares the closed schema with the vendored native example,
   while `apps/cli/src/runtime/native-thai-rag-provider.test.ts` already asserts
   the exact `CanonicalSourceIdentity` object Unified sends.
3. Replace the broken `find ... | xargs sha256sum` refresh recipe with
   `pnpm --filter @unified-mpc/thai-rag contract:provenance`, backed by
   `packages/thai-rag/scripts/write-contract-provenance.mjs`, which writes
   contract-relative JSON keys and skips the descriptive files.

## Explicit non-goals

- No runtime behaviour change and no change to the vendored contract data.
- No new provider work and no fingerprint bump.
- No dependency from `@unified-mpc/workspace` to `@unified-mpc/thai-rag`: the
  CLI suite remains the place where the sender's exact field set is asserted.

## Verification

1. `pnpm --filter @unified-mpc/thai-rag contract:provenance` leaves
   `PROVENANCE.json` byte-identical.
2. `pnpm --filter @unified-mpc/thai-rag test` and `typecheck`.
3. `verify:local` on the exact head, then the exact-head review capsule and a
   fresh reviewer context before the guarded merge.

Refs #705. Refs #210. Parent #210 remains open.
