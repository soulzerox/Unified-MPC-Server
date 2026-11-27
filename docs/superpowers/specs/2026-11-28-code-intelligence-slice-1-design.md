# Code Intelligence slice 1: structural records under canonical source identity

Date: 2026-11-28
Issue: [#131](https://github.com/soulzerox/Unified-MPC-Server/issues/131)
Parent: [#133](https://github.com/soulzerox/Unified-MPC-Server/issues/133) (item: Code
Intelligence on the capability lifecycle)

## Decision

Slice 1 is **extraction only**: read one admitted source tree under an identity
Unified already resolved, and produce deterministic structural records for each
file. No graph queries, no callers/callees, no repo map, no blast radius yet.
Those need a graph to query, and the graph needs a record format that survives a
fingerprint change, so the format comes first.

The rule the whole subsystem answers to, quoted from #131:

> Discover, identify, fingerprint and version source evidence once; let multiple
> Unified subsystems reference the same immutable evidence IDs and generations
> instead of independently rescanning or inventing parallel identities.

Slice 1 only has to not violate that rule. It does not have to satisfy it for
consumers that do not exist yet.

## What already exists, and is reused instead of rebuilt

| need | existing owner | use in slice 1 |
|---|---|---|
| repository / ref / manifest / commit / tree identity | `packages/workspace/src/canonical-source-identity.ts` (`resolveCanonicalSourceIdentity`) | the record key: no second identity scheme |
| canonical ref, manifest and Goal overlay storage | `canonical-ref-store.ts`, `canonical-manifest-store.ts`, `goal-overlay-store.ts` | untouched; slice 1 reads the resolution, never the stores |
| semantic code context, embeddings, incremental index jobs | Thai-RAG provider (`packages/thai-rag`) | untouched; structural records are not embeddings |
| source discovery and file enumeration | the workspace/admission path that produced the identity | slice 1 walks the admitted tree it is handed, it does not re-resolve or re-scan the repository |

Nothing in slice 1 spawns a provider, opens a socket, or starts a worker. The
extractor is a pure function over a path set, which is what lets it become a
capability lane later without changing the record format.

## Slice 1 contract

```text
resolveCanonicalSourceIdentity(...) -> CanonicalSourceResolution  [existing]
        |  only `status: 'bound'` carries an identity
        v
extractStructuralRecords({ repositoryRoot, identity, files })  [new, pure]
        |
        v
readonly SourceStructuralRecord[]   (sorted, stable, no absolute paths)
```

The resolver answers a tagged union, not a bare identity: `absent` (`no_repository`
or `no_canonical_ref`) and `goal_unadmitted` are legitimate non-bound states. Slice 1
does **not** invent an identity for those — extraction is only defined for a `bound`
resolution, and a caller with `absent` has nothing to extract against yet, while a
`goal_unadmitted` caller keeps indexing without a canonical claim, exactly as
`resolveCanonicalSourceIdentity` documents.

### Record shape

```ts
export interface SourceStructuralRecord {
  /** Repo-relative, `/`-separated. Never absolute. */
  readonly path: string;
  /** The identity this record was extracted under; a re-resolution is a new set. */
  readonly identity: CanonicalSourceIdentity;
  /** Content fingerprint of the file as it was read. */
  readonly fingerprint: string;           // `sha256:<hex>`
  readonly language: 'typescript' | 'javascript';
  readonly symbols: readonly StructuralSymbol[];
  readonly imports: readonly StructuralImport[];
  /** Present only when the file could not be parsed; the record still exists. */
  readonly parseError?: string;
}

export interface StructuralSymbol {
  readonly name: string;
  readonly kind: 'class' | 'function' | 'method' | 'interface' | 'type' | 'enum' | 'const' | 'variable';
  /** 1-based, inclusive. */
  readonly startLine: number;
  readonly endLine: number;
  /** Dotted owner chain, e.g. `Outer.inner`. Empty for top level. */
  readonly container: string;
  /** `true` when the declaration is exported from its own module. */
  readonly exported: boolean;
}

export interface StructuralImport {
  /** The specifier as written, un-resolved. */
  readonly specifier: string;
  readonly kind: 'static' | 'dynamic' | 'require' | 're-export';
  readonly startLine: number;
}
```

Three deliberate restrictions:

- **The record is per file, not per symbol.** A symbol id is
  `(path, name, container, startLine)`; keeping the file as the unit means a
  changed file replaces one record instead of a scatter of rows, and it is the
  unit a fingerprint can honestly describe.
- **The record carries the identity, not a database key.** A consumer that
  stores records can dedupe on `(identity, path, fingerprint)` without trusting
  an extractor-assigned number.
- **No absolute paths, no file contents.** A record must be safe to put in a
  receipt, a log line, or a context capsule.

### Determinism

The extractor is the boundary that makes the rest of the subsystem reproducible:

- files are processed in sorted repo-relative path order, compared by code unit
  rather than locale collation;
- symbols are sorted by `(startLine, container, name)`, imports by `startLine`;
- nothing reads the clock, the environment, or the network;
- the same tree and identity produce byte-identical JSON.

A test asserts the last point by extracting the same fixture twice and comparing
the serialized result, which is what makes downstream fingerprints meaningful.

## Containment

- The extractor receives `repositoryRoot` and a file list the caller already
  admitted; it refuses a path that resolves outside `repositoryRoot` (including
  a symlinked file), because "the tree it was handed" must be enforced rather
  than assumed.
- It refuses a non-regular file rather than reading a directory or a device.
- It never follows an import specifier. Slice 1 records specifiers verbatim; a
  resolver is a later slice with its own containment story.

## Language scope

TypeScript and JavaScript only, including `.tsx`/`.jsx` and `.mts`/`.cts` variants,
using the TypeScript compiler API. It is a root `devDependency` today, so the
slice that implements this one must add it as a runtime dependency of the owning
package rather than reaching for the hoisted copy. Other languages are
explicitly out of scope: a second parser is a second failure mode, and the
record format does not change for it later.

## Non-goals for slice 1

- callers/callees, references, implements/extends, blast radius;
- repo map or skeleton generation;
- storing records anywhere durable, or serving them over MCP;
- a capability manifest for the extractor;
- invalidating anything when a repo changes (a later slice owns generation
  reconciliation, and #139 owns event-driven invalidation).

## Slice plan after this one

1. **this slice** — structural records, pure extractor, determinism and
   containment tests;
2. durable record store keyed by canonical identity, with generation
   reconciliation on ref/manifest change;
3. query surface (definitions, imports, references) behind the bounded code
   evidence API from #131;
4. the extractor as an on-demand capability lane, so a large repository pays RSS
   only while a caller is asking for records;
5. consumers: pre-edit context, review, repo map, blast radius.

Step 4 is the one that satisfies the #133 item; steps 1–3 are correctness work
that a capability lane would otherwise be wrapping before it exists.

## Failure modes slice 1 must not introduce

- **A second identity.** If a consumer ever needs "which tree is this?", it asks
  `resolveCanonicalSourceIdentity`, not the extractor.
- **A silent partial result.** A file that fails to parse produces a record with
  `parseError: string`, never a dropped file: a consumer must be able to tell
  "no symbols" from "not read". Whatever the recovering parser still produced is
  kept, so a consumer must treat `parseError` as the authority, not an empty
  `symbols` array.
- **A cross-Goal leak.** Records carry the identity they were extracted under, so
  a Goal overlay's file can never be served as the base ref's file.
