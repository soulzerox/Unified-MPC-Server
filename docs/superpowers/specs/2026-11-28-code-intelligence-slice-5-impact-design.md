# Code Intelligence slice 5 — bounded impact for changed files

Status: implemented with `impactOf` in `packages/code-intelligence/src/structural-query.ts`.
Issue: #131 (rollout item 9, the half the stored evidence can support today).

## The question

A pre-edit or review flow starts from a diff and asks "what is around this change".
The full answer in #131 is a symbol graph: callers, references, implements/extends,
transitive blast radius. Slice 1 stores symbols and un-resolved import specifiers and
nothing else, so only part of that question is answerable now. This slice answers that
part and names its own ceiling, rather than shipping a thin wrapper that looks like a
complete blast radius.

## Contract

```text
impactOf(records, { changedPaths, limit }) -> Result<ImpactReport>

ImpactReport
  basis:         'imports-only'          // stated, not inferred
  targets[]:     one per changed path the records carry
                   path
                   symbols[]          definitions in the changed file
                   dependents[]       files whose specifier names this path
                   parseError?        the symbols are then partial
                   symbolsTruncated / dependentsTruncated
  missingPaths[]: changed paths the generation does not carry
  truncated:      targets or missingPaths were cut to `limit`
```

Rules:

- **one hop, no depth.** A dependent is a lead, exactly as in `dependentsOf`; there is
  no traversal, no ranking and no transitive closure.
- **one entry per dependent file.** `src/c.ts` naming `./a.js` and `./a` is one lead,
  not two.
- **a missing path is reported.** A changed file the generation does not carry is
  `missingPaths`, never an implicit "unaffected".
- **a parse error stays visible.** The target keeps the error, so a partial symbol
  list cannot read as a complete one.
- **every list is bounded.** `changedPaths` set semantics: duplicates collapse, output
  is sorted by code unit. `limit` bounds targets, symbols, dependents and missing
  paths, and `truncated` reports the cut.

Refused with `INVALID_INPUT`: a non-array or empty `changedPaths`, an empty or
non-string entry, and a `limit` outside `1..MAX_QUERY_LIMIT`.

## Non-goals

- Callers/callees, references, implements/extends and symbol-level edges: they need
  resolution, which #131 assigns to the edge-resolution slice.
- Test inference: guessing which tests cover a symbol from a filename is not evidence.
- Persistence: this is a projection over records the caller already read from one
  stored generation, so there is no new table, index or cache.
