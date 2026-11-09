# Plan: publish the Unified ↔ Thai-RAG field matrix (#210 §1 / §13)

Issue: soulzerox/Unified-MPC-Server#210, first bullet under "Thai-RAG contract
and adapter alignment". Parent #210 remains open.

## Context

The `code_index` identity/fence fields are already sent by
`apps/cli/src/runtime/native-thai-rag-provider.ts` and already validated by the
vendored provider contract, but nothing in the repository states the complete
matrix in one place: which fields Unified owns, which the provider owns, which
are result-only, and where generation compatibility is negotiated. The next
slices (standalone #61, artifact GC, FTS5 freshness) need that reference so
they do not re-derive it from code each time.

## Scope

1. Publish `docs/superpowers/specs/2026-11-09-unified-210-provider-field-matrix.md`:
   ownership split, request fields, closed `source_identity`, fence derivation,
   result-only `repository_provenance` / `trust_scope`, never-sent
   `canonical_binding` / `canonical_fence`, generation/embedding compatibility,
   standalone mode, and the tests that pin each claim.
2. Add `keeps every published identity inside the closed result contract` to
   `packages/thai-rag/src/provider-contract.corpus.test.ts` so the matrix cannot
   drift from the vendored corpus: closed result envelope, provenance/trust
   pairing, six-field closed identity, and the documented patterns.
3. Accept the documented `source_identity: null` answer (standalone /
   lexical-only) instead of treating it as a contract violation.

## Explicit non-goals

- No runtime change in `native-thai-rag-provider.ts`.
- No change to the vendored contract, its hashes or `PROVENANCE.json`.
- No attempt to close #210 bullets 3–5 (standalone #61, artifact GC, FTS5
  freshness); they stay open.

## Verification

1. `pnpm --filter @unified-mpc/thai-rag test` — 157 passed.
2. `typecheck` and `eslint` on the changed test.
3. `verify:local` on the exact head, then the exact-head capsule and a fresh
   reviewer context before the guarded merge.

Refs #210. Parent #210 remains open.
