# Code Intelligence slice 7 — discovery by git, not by a second ignore engine

Status: implemented as `discoverStructuralFiles` / `indexStructuralWorkspace` in
`packages/code-intelligence/src/structural-index.ts`.
Issue: #131 (rollout item 4 glue: which files exist at all).

## The decision

The repository already knows which files a commit carries. A subsystem that walks the
tree with its own `.gitignore` parser answers "which files exist" a second time, and the
two answers drift the first time a pattern is unusual.

So discovery asks Git for the index:

```text
git ls-files -z --cached
```

Only files in the index are evidence. The canonical identity is a commit and a tree, so a
record written for an untracked file would be attributed to a commit that never carried
it — and the store cannot correct an immutable generation.

The index alone is not enough to make that true, because extraction fingerprints the bytes
on disk: a staged edit is in the index and not in the commit, and the byte could differ
from both. So `indexStructuralWorkspace` checks the checkout itself before it discovers
anything:

| check | refusal |
|---|---|
| `git status --porcelain` is empty | uncommitted bytes cannot be attributed to a commit |
| `git rev-parse HEAD` equals `identity.commit_sha` | a clean checkout of another commit is the wrong tree |
| `git rev-parse HEAD^{tree}` equals `identity.tree_oid` | the generation id derives from commit and tree, so both must match |
| `repositoryRoot` is the worktree toplevel | a subdirectory's relative paths would read as repository paths |

Only when all four hold do the index, the worktree and the identity agree. Commit, then
index.

## Contract

```text
discoverStructuralFiles({ repositoryRoot, listFiles? }) -> Result<readonly string[]>

indexStructuralWorkspace({ store, identity, repositoryRoot, listFiles? })
  = discoverStructuralFiles -> buildStructuralGeneration
```

- only the eight `STRUCTURAL_SOURCE_EXTENSION` extensions survive, case-insensitively;
  that pattern is one module shared with the extractor's admission gate and the specifier
  heuristic;
- duplicates collapse and the result is code-unit sorted, the order every query
  documents;
- a producer that is not a Git worktree is `INVALID_INPUT` from Git with its message,
  not an empty list;
- `discoverStructuralFiles` may return `ok([])`: a tree with no source files has no
  structural evidence, and that is an answer. `indexStructuralWorkspace` is the one that
  refuses an empty generation, because storing it would be immutable evidence that the
  tree has no code;
- `indexStructuralWorkspace` refuses a dirty worktree, a `HEAD` that is not the
  identity's commit, and a root that is not the worktree toplevel;
- `listFiles` is injectable so the filter and order are testable without spawning Git.

## Non-goals and known edges

- **Submodules** are Git's answer, taken as given.
- **Uncommitted work is refused, not silently skipped.** Indexing needs a clean
  checkout; commit first.
- **`assume-unchanged` and `skip-worktree` are invisible to `git status`.** A file
  marked that way can hold modified bytes that the gate accepts. Do not mark source
  files you intend to index; the subsystem cannot see through Git's own advice.
- **No parallelism or progress.** Extraction is still one sequential call; the worker
  slice owns concurrency.
