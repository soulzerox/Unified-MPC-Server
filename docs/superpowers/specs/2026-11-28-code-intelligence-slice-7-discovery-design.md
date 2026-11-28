# Code Intelligence slice 7 — discovery by git, not by a second ignore engine

Status: implemented as `discoverStructuralFiles` / `indexStructuralWorkspace` in
`packages/code-intelligence/src/structural-index.ts`.
Issue: #131 (rollout item 4 glue: which files exist at all).

## The decision

The repository already knows which files are tracked and which are ignored. A
subsystem that walks the tree with its own `.gitignore` parser answers "which files
exist" a second time, and the two answers drift the first time a pattern is unusual.

So discovery asks Git:

```text
git ls-files -z --cached --others --exclude-standard
```

`--cached` includes tracked files, `--others --exclude-standard` includes untracked
files that are not ignored. A generation then describes the tree on disk, not the last
commit, and an ignored build artefact never enters evidence.

## Contract

```text
discoverStructuralFiles({ repositoryRoot, listFiles? }) -> Result<readonly string[]>

indexStructuralWorkspace({ store, identity, repositoryRoot, listFiles? })
  = discoverStructuralFiles -> buildStructuralGeneration
```

- only the eight `STRUCTURAL_SOURCE_EXTENSION` extensions survive; that pattern is one
  module shared with the extractor's admission gate and the specifier heuristic;
- duplicates collapse and the result is code-unit sorted, the order every query
  documents;
- a producer that is not a Git worktree is `INVALID_INPUT` from Git with its message,
  not an empty list;
- a checkout with no source files is `INVALID_INPUT`, because an empty generation would
  be immutable evidence that the tree has no code;
- `listFiles` is injectable so the filter and order are testable without spawning Git.

## Non-goals and known edges

- **Submodules and sparse checkouts** are Git's answer, taken as given.
- **A tracked file missing from the worktree** is still listed, and extraction refuses
  it. That is a stale checkout, and refusing beats silently dropping evidence for a
  file the repository says exists.
- **No parallelism or progress.** Extraction is still one sequential call; the worker
  slice owns concurrency.
