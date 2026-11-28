# Code intelligence slice 8: bounded evidence read

Status: implemented. Refs #131.

## The gap

Slices 3 to 7 built two halves that never met. `structural-query.ts` projects an array
of records the caller already holds, and `StructuralRecordStore` writes and pages a
generation. Nothing loaded one into the other, so no consumer could ask a question about
a stored generation — every query function was reachable only from tests.

## The slice

One function, and deliberately only that function:

```ts
loadStructuralEvidence({ store, identity, paths? })
  -> { generationId, records }
```

It returns records, not answers. Each consumer already knows which of the seven query
functions it wants (`findSymbols`, `outlineOf`, `impactOf`, …), and a dispatcher that
mapped one to the other would be a union type and a switch that add nothing this slice
needs. The join is the missing piece; the projection is not.

## Rules

- **Exact identity, never "the latest".** `readGeneration(identity)` only. A query
  answered from a newer tree would be evidence about code the caller is not looking at,
  and the store is identity-addressed precisely so a consumer can pin a generation.
- **Missing evidence is an error.** No stored generation is `INVALID_INPUT` with "index
  the workspace first", not `ok([])`. An empty list would let a consumer report "no
  symbols" for a repository nobody indexed.
- **The whole-generation read is capped at `MAX_EVIDENCE_FILES` (2000)**, the same
  ceiling as `MAX_QUERY_LIMIT` and the store's read limit, so anything that fits one
  answer fits one read. A full first page is followed by a one-row keyset probe: the
  ceiling is 2001 rows read regardless of repository size.
- **Above the cap, refuse; never truncate.** The refusal names the generation and says to
  pass paths. A shortened list would be indistinguishable from a repository that really
  has fewer files, and #131 requires structural uncertainty to be explicit.
- **Path-scoped reads are not capped by generation size.** `paths` goes through the
  store's `IN` filter with `limit === paths.length`, which is what makes a large
  repository answerable: the caller names the file it is asking about. More than 2000
  paths is refused, matching the store.

## Why not stream or truncate

Streaming records to a query function would mean the query functions grow a cursor and a
partial-result flag, and every one of them would need to say what a partial answer means
for its own shape (a truncated outline is a missing function, a truncated summary is a
lie about the repository). The bounded-read-plus-refusal keeps that decision where it
belongs: with the consumer that knows what it is asking.

## Tests

Seven cases: missing generation refused; scoped read sends exactly the named paths;
empty path list answers without reading; whole read below the cap; exactly the cap
accepted; above the cap refused with only the capped page plus one probe read; more than
the cap paths refused without reading.
