# Code Intelligence slice 3: a bounded query surface over stored records

Date: 2026-11-28
Issue: [#131](https://github.com/soulzerox/Unified-MPC-Server/issues/131)
Depends on: slice 1 (`0c0f55a`), slice 2 (record store)

## Decision

Slice 3 answers questions about one stored generation and does not extract,
resolve, persist or rank anything.

The store from slice 2 already returns the records of an exact generation. A query
surface is therefore a **projection**: pure functions over `readonly
SourceStructuralRecord[]` that the caller obtained from `readRecords`. No second
table, no second index, no cache, no migration. If a query cannot be answered from
the records the store holds, it is not in this slice.

That constraint is what keeps the subsystem honest: the answer to "where is
`Foo` defined" is a filter over immutable evidence with a generation id attached,
not a graph that can drift away from the tree it claims to describe.

## Where the code lives

| piece | package | why |
|---|---|---|
| `structural-query.ts` (pure functions + result shapes) | `packages/code-intelligence` | depends only on the record types, so it is usable with or without the SQLite store and stays out of `node:sqlite` |
| nothing | `packages/storage` | a projection needs no new table, and adding a store-side query API would duplicate the filters a caller composes |

`packages/code-intelligence` keeps zero runtime dependency on `typescript` for this
module (type-only import), so a consumer that only queries does not load the
compiler.

## Shape

```ts
interface QueryPage<T> { items: readonly T[]; truncated: boolean }

findSymbols(records, { name?, kind?, exported?, pathPrefix?, limit })
  -> Result<QueryPage<SymbolHit>>   // SymbolHit = { path, name, kind, container, startLine, endLine, exported }

definitionsOf(records, { name, limit })
  -> Result<QueryPage<SymbolHit>>   // exact, case-sensitive name match

outlineOf(records, { path })     // one file, so no limit: it is not a list
  -> Result<FileOutline | undefined>   // { path, language, symbols, imports, parseError? }

importsOf(records, { path, limit })
  -> Result<QueryPage<StructuralImport> | undefined>

dependentsOf(records, { path, limit })
  -> Result<QueryPage<DependentHit>>   // { path, specifier, resolution: 'heuristic' }

repoSummary(records, { limit })
  -> Result<RepoSummary>   // { fileCount, symbolCount, unparsedCount, languages, truncated }
```

`RepoSummary` carries its own `truncated` because its per-language breakdown is the
bounded part: a consumer must be able to tell a complete language list from the
first `limit` of them.

Every function takes records the caller already has. Nothing here reads the disk,
opens a database or knows a generation id; the caller passes the generation it read,
so a result set is always attributable to one immutable extraction.

A caller whose tree is larger than one page reads it with slice 2's `afterPath`
cursor and queries the accumulated records, or pages the records and filters each
page. The query surface never asks the store for "everything".

## Rules that carry the slice

1. **Bounded.** Every query that returns a list takes a mandatory `limit` and
   returns at most that many entries; a `limit` outside `1..MAX_QUERY_LIMIT` is
   `INVALID_INPUT`. `MAX_QUERY_LIMIT = 2000` is exported by this module so the
   bound is nameable from outside — it is the same number the store uses for a page,
   but the store's constant is private to `packages/storage`, and slice 3 must not
   depend on that package to state it. There is no "unbounded" overload, and
   `repoSummary`'s `limit` bounds its per-language breakdown, which is why
   `RepoSummary` reports `truncated` itself.
2. **Deterministic order.** `path` by code unit, then `startLine`, then `name`. No
   `localeCompare`, no score, no recency. Two callers with the same records and the
   same query get the same list, which is what makes a review citation stable.
3. **Truncation is visible.** A result that hit the limit says so (`truncated:
   true` on the list-returning functions) instead of silently returning a short
   answer that looks complete.
4. **Unparsed is not empty.** `outlineOf` on a file with `parseError` returns the
   error and the (possibly empty) symbol list; `repoSummary` counts `unparsed`
   separately, so "no symbols because the file is broken" never reads as "file has
   no symbols".
5. **No semantic claims.** `dependentsOf` matches a stored, *un-resolved* specifier
   against the requested path and marks every hit `resolution: 'heuristic'`. It does
   not claim to resolve `./b.js` to `b.ts`; that mapping needs a resolution slice
   with its own provenance (`syntax-derived` / `name-resolved` / `type-resolved`).
   Reporting a heuristic hit as resolved is the upstream failure mode #131 names.

   The comparison is stated so the answer is decidable: strip leading `./` and any
   `../` segments from the specifier, then a hit is a hit when — after also dropping
   one source extension (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`) from both sides —
   the specifier equals the target, or the target ends with `/<specifier>`. So
   `./a.js` and `./a` both name `a.ts`, and `../lib/util.js` names
   `lib/util.ts`; nothing else does. Extension stripping *is* a small resolution
   step, which is exactly why the result is labelled `heuristic` and never
   `name-resolved`.
6. **No contents.** Results carry names, kinds, ranges and specifiers — never file
   bytes or comments.

## Non-goals

- callers/callees, references, implements/extends, blast radius — every one needs
  edge resolution and provenance that this slice does not have (slice 5+);
- the Goal overlay — a Goal shares its base generation, and the overlay is not
  structural evidence (slice 2's contract);
- persistence, caching, pre-computed indexes — the pages the store already returns
  are the input;
- the capability lane / MCP tool registration — slice 4;
- text search, grep or ranking — #14 and Thai-RAG own those.

## Tests slice 3 must carry

- a symbol is found by exact name across two files, ordered by path then line;
- `kind`, `exported` and `pathPrefix` filters each narrow the result, and an
  unmatched filter returns `[]`, not an error;
- `definitionsOf` is case-sensitive and does not match a prefix or a substring;
- a limit of 1 over three matches returns the first in path order with
  `truncated: true`, and a limit of 0 or a non-integer is `INVALID_INPUT`;
- `outlineOf` returns a broken file's `parseError` and does not pretend the file is
  empty, and returns `undefined` for a path that is not in the records;
- `importsOf` returns the record's imports in line order and respects `limit`;
- `dependentsOf` marks every hit `heuristic` and matches only the requested path;
- `repoSummary` counts an unparsed file separately and its per-language breakdown
  respects `limit`;
- the same records queried twice produce identical output (no hidden state).
