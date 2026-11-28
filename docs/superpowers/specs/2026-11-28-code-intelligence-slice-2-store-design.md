# Code Intelligence slice 2: a durable record store keyed by canonical generation

Date: 2026-11-28
Issue: [#131](https://github.com/soulzerox/Unified-MPC-Server/issues/131)
Depends on: slice 1 (`packages/code-intelligence`, merged as `0c0f55a`)

## Decision

Slice 2 stores what slice 1 extracts, and nothing else. No query surface, no
references, no callers/callees, no capability lane. A store that answers one
question — "give me the records for this exact generation" — is what makes the
query surface in slice 3 a projection instead of a second extraction.

The unit of durability is the **generation**, not the file:

```text
CanonicalSourceIdentity (repository, manifest, revision, commit, tree, ref)
        |
        v
generation_id = sha256(repository_id \0 manifest_id \0 revision_id \0 commit_sha \0 tree_oid \0 ref)
        |
        v
records[path] -> { fingerprint, language, symbols, imports, parseError? }
```

A generation is immutable once written. A consumer that pins a generation keeps
reading the same bytes even after the ref moves, which is the whole point of
carrying an identity in the record.

## Where the code lives

| piece | package | why |
|---|---|---|
| `StructuralRecordStore` interface + record/generation shapes | `packages/code-intelligence` | the port belongs to the consumer-facing package, so the extractor and the store share one type without a cycle |
| `SqliteStructuralRecordStore` | `packages/storage` | every durable repository in this repo lives there, with its migration module and integration test |
| migration `STRUCTURAL_RECORD_MIGRATION_SQL` | `packages/storage/src/migrations` | the same append-only pattern as every other table |

`packages/code-intelligence` must not depend on `packages/storage` (or on
`node:sqlite`), so the extractor stays a pure function and a future capability
lane can hold the store without dragging the whole storage graph in.

## Table

```sql
CREATE TABLE structural_record_generations (
  generation_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  manifest_id   TEXT NOT NULL,
  revision_id   TEXT NOT NULL,
  commit_sha    TEXT NOT NULL,
  tree_oid      TEXT NOT NULL,
  ref           TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  written_at    TEXT NOT NULL,
  file_count    INTEGER NOT NULL
);

CREATE TABLE structural_records (
  generation_id TEXT NOT NULL REFERENCES structural_record_generations(generation_id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,
  language      TEXT NOT NULL,
  parse_error   TEXT,
  payload       TEXT NOT NULL,          -- the SourceStructuralRecord as JSON
  PRIMARY KEY (generation_id, path)
);

CREATE INDEX structural_records_by_path ON structural_records(path, generation_id);
```

Two deliberate choices:

- **The record body is one JSON column.** The only predicates slice 2 needs are
  by generation and by path; normalizing symbols into rows now would be a schema
  for a query that does not exist yet. Slice 3 either uses SQLite's `json_each`
  against `payload` or adds a projection table when a real query needs it — and
  the projection is then derivable from `payload`, not a second source of truth.
- **`fingerprint` and `parse_error` are columns.** They are the two fields a
  consumer asks about without wanting the payload ("did this file change", "was
  it read"), and `parse_error IS NOT NULL` is the explicit-uncertainty index.

## Interface

```ts
export interface StructuralGeneration {
  readonly identity: CanonicalSourceIdentity;
  readonly generationId: string;
  readonly schemaVersion: number;
  readonly writtenAt: string;
  readonly fileCount: number;
}

export interface StructuralRecordStore {
  /** Writes a whole generation in one transaction; a re-write of the same id is refused. */
  writeGeneration(input: {
    readonly identity: CanonicalSourceIdentity;
    readonly records: readonly SourceStructuralRecord[];
  }): Promise<Result<StructuralGeneration>>;

  /** The generation for this exact identity, or `undefined`. Never "the latest". */
  readGeneration(identity: CanonicalSourceIdentity): Promise<Result<StructuralGeneration | undefined>>;

  /** Records of one generation, ordered by path. Bounded by `limit`. */
  readRecords(input: {
    readonly generationId: string;
    readonly paths?: readonly string[];
    readonly limit: number;
  }): Promise<Result<readonly SourceStructuralRecord[]>>;

  /** Fingerprints only: the cheap "what changed" answer, no payload. Same bound as `readRecords`. */
  readFingerprints(input: {
    readonly generationId: string;
    readonly paths?: readonly string[];
    readonly limit: number;
  }): Promise<Result<readonly { readonly path: string; readonly fingerprint: string }[]>>;
}
```

`readGeneration` takes an identity rather than a "latest for ref" argument on
purpose: "latest" is a different, staleness-sensitive question, and answering it
here would let a caller act on a generation it never resolved. A future slice
that needs it adds `latestForRef(ref)` with its own documented staleness.

The store refuses, it does not repair:

- records whose `identity` differs from the write's identity are an
  `INVALID_INPUT` refusal: one generation describes one tree, so a caller mixing
  identities is a bug the store must not persist. This is not the overlay guard —
  an admitted Goal shares the base identity (see the reconciliation section) — it
  only keeps a write honest about what it is writing;
- two records with the same `path` in one generation are refused, because slice 1
  already collapses duplicates and a store must not invent an ordering rule;
- a fingerprint that is not `sha256:<64 hex>` is refused, so a caller cannot
  write a generation that a later equality check will not mean anything for;
- a `path` that is not canonical repo-relative is refused, judged **by segment**:
  absolute paths, `../x`, `src/../../x`, `a/./b` and `a//b` are `INVALID_INPUT`,
  while `..foo.ts` is a legal name and a literal backslash on POSIX is one segment,
  not a separator. Slice 1 can emit such a name, so the store must not treat a
  legal filename as an escape;
- an **empty** extraction is refused: an identity has exactly one generation and
  there is no delete, so accepting a zero-file generation would forbid the real
  extraction for that identity forever.

Reads are bounded and fail closed: `limit` must be an integer in `1..2000`, a
`paths` filter may carry at most 2000 entries (one SQL placeholder each), and a
`generationId` that names no stored generation is `INVALID_INPUT` rather than an
empty page — because an empty generation cannot exist, "no rows" means the id is
wrong, not that the tree is empty.

A generation may hold more records than one `limit` allows, so both reads take an
exclusive keyset cursor, `afterPath`: "give me the next page after this path". An
offset would re-read shifting rows, while the order here is immutable, so the last
path of a page is the whole cursor. A generation read by a build that does not know
its stored `schema_version` is refused instead of being interpreted as if it did.

## Immutability and re-extraction

Writing the same generation twice is refused, not merged. Two reasons:

- the id is **identity-addressed**, not content-addressed: it names the tree the
  records describe. A second write for the same identity is therefore either a
  retry after a lost response or a re-extraction that disagrees with the stored
  one, and the store cannot tell them apart — so it keeps what it has and refuses
  the write. A retrying caller reads the generation back instead of writing again;
- a consumer that pinned the generation would otherwise see its data change
  underneath it.

A genuine re-extraction produces the same id only if the identity is identical,
and then the records should be identical too (slice 1 is deterministic). If they
are not, something upstream of the store is nondeterministic and refusing is the
honest answer. The integration test asserts this: extract twice, write once, and
the second write of the same id is refused with the stored generation unchanged.

## Generation reconciliation (and what is explicitly not here)

When the ref moves, the new extraction has a new `revision_id`/`commit_sha`, so it
is a new generation. Old generations stay readable.

A Goal does **not** get a second generation. `resolveCanonicalSourceIdentity`
returns the same six fields for an admitted Goal as for its base ref: admission
means the overlay's recorded base still matches the live ref, so the covered tree
is the same tree and the records are shared evidence — #131's reuse requirement,
not a per-Goal copy. The overlay itself stays where it is (`goal-overlay-store.ts`)
and is not structural evidence. A Goal whose overlay base no longer matches is
`goal_unadmitted` and has no canonical identity at all, so it has nothing to write
here.

That makes one caller contract load-bearing: the caller must extract the tree the
identity describes (a checkout at `commit_sha`), not a worktree with overlay edits
on top. The store cannot enforce it, and it cannot detect it either when the
identity has no stored generation yet — there is nothing to compare against, and
the wrong bytes would become that identity's generation.

What the store does guarantee is that a mislabelled extraction can never coexist
with the correct one: an identity has exactly one stored generation, so if the
correct generation was written first the mislabelled write is refused outright, and
if it was not, a later correct extraction hits that same refusal. Detecting the
second case needs a comparison the store does not do — re-extracting the described
tree and checking the stored fingerprints — which is the caller's job and not
implemented by this slice.

Deletion is not part of this slice **and no deletion API ships with it**. #131
requires cleanup to be reference-aware ("Cleanup is reference-aware and cannot
remove shared evidence still used by another Project/Goal"), and slice 2 has no
reference graph to consult, so the store offers no way to delete a generation at
all rather than offer a way that cannot check. The tables carry `ON DELETE
CASCADE` on the records, which is a migration detail the later slice will use, not
a capability this one exposes.

Slice 2 therefore ships **no retention at all**:

- nothing is pruned on write;
- there is no `deleteGeneration` in the interface to call by mistake;
- the store exposes `file_count` and `written_at` per generation so a future
  retention policy has the data it needs without a schema change.

The alternative — "prune all but the newest N generations per repository" — is
wrong here because the newest generation for a repository is not the newest
evidence a Goal may be reading. A note in the code marks the ceiling
(`ponytail:` comment) and names the reference-aware slice that lifts it.

## Size bound

A record payload is a few kilobytes at most (symbols and import specifiers, no
contents, no absolute paths), and both read methods require an explicit `limit`, so
callers cannot pull a whole monorepo into one result by accident. There is no
`limit: Infinity` escape hatch; a caller that wants everything pages by path.

## Non-goals for slice 2

- query surface (definitions/imports/references) — slice 3;
- automatic retention, garbage collection, or cross-Goal reference tracking — a
  later slice, and #131 requires it to be reference-aware;
- event-driven invalidation from filesystem notifications — #139 owns that, and
  reconciliation here stays hash/revision-based;
- secrets classification before persistence — #137 owns it, and slice 2 stores
  specifiers and symbol names, never file contents;
- the extractor as a capability lane — slice 4.

## Tests slice 2 must carry

- write → read round-trips a generation's records byte-identically, ordered by path;
- `readGeneration` for an unwritten identity is `undefined`, never a neighbouring
  generation;
- a second write of the same generation id is refused and leaves the first intact;
- a record whose identity differs from the write is refused;
- duplicate paths in one write are refused;
- a malformed fingerprint is refused;
- `readFingerprints` returns the same page as `readRecords` for the same `limit`
  and `paths`, without payloads;
- `readRecords` and `readFingerprints` respect `limit` and the `paths` filter;
- the migration is idempotent (applied twice on one database is a no-op).
