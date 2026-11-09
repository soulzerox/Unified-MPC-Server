# Plan: vendor the Thai-RAG provider contract v1 corpus (#210 follow-up)

## Context

Thai-RAG published the normative, machine-readable provider contract at
`soulzerox/thai-rag-mcp` `contract/` (issue #1 / PR #423): the draft 2020-12
schema, a conformance corpus of complete `ProviderResult` envelopes with an
expectation manifest, and the canonical native/standalone `code_index` request
examples. The #210 comment that announced it asked Unified to "copy the schema
and corpus at a pinned commit, validate every provider result before acting on
it, and run the corpus against the native adapter".

Unified already implements both halves of the boundary — the handshake parser
and the provider `ErrorCode` → Unified `AppErrorCode` table — but they live
inside `apps/cli/src/runtime/native-thai-rag-provider.ts`, are private, and are
therefore only exercised by hand-written cases. Nothing in this repository knows
which corpus revision the constants were last checked against, so a provider
`ErrorCode` addition (open within v1, and deliberately invisible in
`contract_fingerprint`) can reach Unified with no mapped classification and no
failing test.

This slice vendors the corpus and moves the two boundary readers into
`@unified-mpc/thai-rag`, so the corpus runs against the same code the runtime
uses.

## Scope

1. Vendor `contract/README.md`, `provider-contract.v1.schema.json`,
   `examples/*.json` and `fixtures/*.json` from thai-rag-mcp at a pinned commit
   into `packages/thai-rag/contract/`, with `PROVENANCE.json` recording the
   source repository, commit and one sha256 per vendored file.
2. Move the provider `ErrorCode` table and its helpers into
   `provider-contract.ts` as exported `THAI_RAG_PROVIDER_ERROR_CODE_MAP`,
   `isThaiRagProviderErrorCode` and `mapThaiRagProviderErrorCode`.
3. Move the handshake **payload** reader into `provider-contract.ts` as
   `parseThaiRagHandshakePayload`. The CLI keeps only the transport unwrap
   (`normalizeWorkerPayload`), because `structuredContent`/`content[0].text` is
   an MCP detail, not a provider-contract field.
4. Add `provider-contract.corpus.test.ts` proving, against the vendored files:
   - every vendored file still matches its provenance hash and the manifest
     lists exactly the files on disk;
   - the fixture index lists exactly the corpus files it describes;
   - every fixture's `metadata` identity uses `provider_name: thai-rag`, the
     supported `contract_version`, a supported fingerprint and the
     index-job contract version that fingerprint attests;
   - every health fixture parses through the real payload reader and validates
     with the documented verdict (`ready` accepts, `degraded` accepts only with
     the allowed degraded capability, `unavailable` refuses with
     `health-unavailable`);
   - every fixture `errors[].code` is in the schema enum and is mapped by
     Unified's table, and every mapped value is a real `AppErrorCode`;
   - the schema's closed `source_identity` field set still matches the vendored
     native example; the CLI suite separately asserts the exact identity
     Unified sends.
5. Document the refresh procedure in `packages/thai-rag/contract/VENDORED.md`.

## Explicit non-goals

- No JSON Schema engine. The corpus is validated through the typed boundary
  readers that actually run before Unified acts on a provider result; adding a
  second schema interpreter would let the two disagree.
- No runtime behaviour change: the moved functions keep their current semantics
  and error text, and only their module location and names change.
- No provider work, no fingerprint bump, and no change to
  `SUPPORTED_INDEX_JOB_CONTRACTS`.
- No automatic fetch/update. The corpus is vendored at a pinned commit and the
  hash test refuses an unrecorded edit.

## Safety

- The vendored corpus is data only; nothing imports it at runtime.
- A fixture that fails unchanged is a contract break, so the test reports the
  fixture path in the assertion message.
- `PROVENANCE.json` and `VENDORED.md` are deliberately excluded from the hash
  set: they describe the copy, they are not part of it.

## Verification

1. `pnpm --filter @unified-mpc/thai-rag test` and `typecheck`.
2. `pnpm --filter @unified-mpc/cli test` for the provider runtime suites that
   exercise the moved helpers through the adapter.
3. `verify:local` on the exact head, then the exact-head review capsule and a
   fresh reviewer context.
4. RED proof: temporarily delete one entry from the vendored error map (or point
   a fixture at an unknown code) and confirm the corpus test fails before
   restoring it.

Refs #210. Parent #210 remains open.
