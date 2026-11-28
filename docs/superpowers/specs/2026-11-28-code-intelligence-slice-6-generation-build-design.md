# Code Intelligence slice 6 — building a generation from a checked-out tree

Status: implemented as `buildStructuralGeneration` in
`packages/code-intelligence/src/structural-index.ts`.
Issue: #131 (rollout items 4–5 glue; unblocks every consumer).

## The gap

Slices 1 and 2 were verified separately: the extractor as a pure function, the store
with synthetic records. Nothing proved they compose, and nothing in the repository
could produce the generation that consumers, the capability lane and the impact query
all read. This slice is that glue and nothing more.

## Contract

```text
buildStructuralGeneration({ store, identity, repositoryRoot, files })
  -> Result<StructuralGeneration>
```

1. `files` must be a non-empty array of non-empty strings. An empty generation would
   state "this tree has no code" as immutable evidence, and the store refuses a
   rewrite, so the mistake could never be corrected. Paths are *not* deduplicated
   here: the extractor admits a path by its repo-relative form, so `./a.ts` and
   `a.ts` are one file and contribute one record. A raw-string check would refuse a
   pair the reader already understands.
2. Extraction is delegated to `extractStructuralRecords`, so the slice inherits its
   refusals: an absolute path, one escaping the root, an unsupported language, a
   non-regular file and invalid UTF-8 are `INVALID_INPUT`, and nothing is written.
3. Records are written with `store.writeGeneration` in one call, under the canonical
   identity the caller supplied. The store keeps its own rules: a second write of the
   same identity is `CONFLICT`, and it is returned unchanged.

## Non-goals

- **No filesystem walk.** `files` is the caller's discovery result. Ignore rules and
  worktree policy are not this function's: the composite that discovers files from Git
  and checks the checkout is `indexStructuralWorkspace` (slice 7).
- **No incremental update.** The store is identity-addressed and immutable: one
  generation is one full extraction, and a partial refresh needs a new identity.
- **No parallel extraction or progress reporting.** That is the worker slice's job;
  this call is the synchronous path a test and a small repository can use.
