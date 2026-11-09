# Vendored Thai-RAG provider contract

This directory is a verbatim copy of `contract/` from
[soulzerox/thai-rag-mcp](https://github.com/soulzerox/thai-rag-mcp), pinned by
`PROVENANCE.json`. It exists so the boundary readers in
`packages/thai-rag/src/provider-contract.ts` are tested against the published
corpus, not against hand-written envelopes.

`provider-contract.corpus.test.ts` fails when a vendored file is edited without
updating `PROVENANCE.json`, when a fixture uses an unmapped `ErrorCode`, or when
the corpus adds a file the manifest does not describe. Do not edit a vendored
file by hand.

## Refresh

1. Check out the exact Thai-RAG commit you want to vendor and note
   `git rev-parse HEAD`.
2. Replace `README.md`, `provider-contract.v1.schema.json`, `examples/` and
   `fixtures/` with that commit's `contract/` contents, keeping
   `PROVENANCE.json` and this file.
3. Set `sourceCommit` and `vendoredAt` in `PROVENANCE.json`.
4. Regenerate the `files` hash map from the repository root:

   ```sh
   find packages/thai-rag/contract -type f \
     ! -name PROVENANCE.json ! -name VENDORED.md \
     | sort | xargs sha256sum
   ```

5. Run `pnpm --filter @unified-mpc/thai-rag test`. A failure means the new
   corpus disagrees with Unified's boundary readers; that is the point of the
   guard, so fix the reader or the mapping before pinning the new commit.
