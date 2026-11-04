# Unified #210 slice — canonical index GC plan (`--dry-run`)

Issue: soulzerox/Unified-MPC-Server#210 (§1 canonical artifacts, §7 GC)
Depends on: U17 `planArtifactGc`, U18 `assembleGcRoots`, U21
`ArtifactQuarantineStore`, U22 `runGcCycle`, `planRepositoryArtifactGc`, and the
#623–#627 operator verbs (`status`, `revision list`, `pin|unpin`, `prune`).
Status: plan-first, red-first implementation in this slice.

## Why this slice now

`runGcCycle` already plans both artifact id spaces and writes quarantine rows
under the cleanup lease, but it has no caller in the product. The only way to
see whether anything is collectible is a unit test, and a dry run could not even
report artifact keys: `runCycle` returned `quarantinedArtifacts: []` in dry-run
mode, so a read-only caller saw an empty list that looked like "nothing to
collect" even when the plan held rows.

This slice exposes the read-only half. Quarantine and physical deletion stay out
because they mutate, need the U28 cleanup lease, and deletion is a separate
scheduled step by design.

## What lands

### 1. Report plan field (`packages/workspace/src/gc-cycle.ts`)

`GcCycleReport` (planned branch) gains `unreachableArtifacts`: the artifact-key
candidates the plan would quarantine. It is populated in both modes, while
`quarantinedArtifacts` stays what was actually written. Additive; the existing
`quarantined` / `quarantinedArtifacts` semantics are unchanged, so a caller can
still tell "planned" from "done".

### 2. Candidate universe (`packages/workspace/src/canonical-artifact-store.ts`)

`CanonicalArtifactStore.list()` exposes every record across trust boundaries for
a GC pass. Asking per repository would hide records whose manifest moved or was
already pruned. Read-only, sorted like the rest of the store API. Chunk records
are listed too; filtering them is caller policy.

### 3. `apps/cli/src/commands/index-gc.ts` (new module)

`parseIndexGcArgs` parses `gc --dry-run [--json]`:

- `--dry-run` is **required**, not defaulted, so the verb cannot become a
  mutation by omission.
- `--apply` is rejected with a specific message so an operator learns the verb
  is read-only from the command itself.
- Duplicate flags, unknown flags and positional arguments are `INVALID_INPUT`
  (exit `2`).

`formatIndexGc(report)` prints:

```
planned (dry-run) reachable <n> unreachable <n> artifact-unreachable <n>
unreachable <content-hash>
artifact-unreachable <repository-id> <artifact-key>
```

A refused plan prints `refused <reason>`; `indexGcExitCode` maps a plan to `0`
and a refusal to `1`, because a refusal is a safety verdict about the store, not
a successful read.

### 4. CLI wiring (`apps/cli/src/index.ts`)

- `parseCliArgs` dispatches `index gc`; the sibling usage string lists `gc`.
- `CliDependencies.indexGc({ dryRun: true })` returns `GcCycleReport`; the
  dispatch prints JSON or the operator lines and maps a missing dependency or
  thrown store error to exit `1`.
- `createDefaultCliDependencies` resolves `<dataPath>/canonical`, asserts storage
  identity, lists file artifacts, constructs refs/manifests/pins/overlays/
  quarantine/artifact stores plus `IndexJobLedger`, reads `liveManifestIds()`
  immediately before planning, and passes `dryRun: true` unconditionally.
- Chunk artifacts are filtered out of both candidate lists: the artifact-key
  planner reads file bindings only, so passing chunk keys would mark every chunk
  unreachable, and semantic chunk GC belongs to the Thai-RAG boundary.
- Help gains one line: `index gc --dry-run`.

### 5. Docs and guard

- `docs/CLI_REFERENCE.md` §9 gains the GC subsection after prune, including the
  two id spaces, the chunk exclusion, the refusal exit code and the advisory
  warning.
- `apps/cli/src/docs-examples.test.ts` gains the semantic expectation and a
  replay dependency, so the documented command line cannot drift from the
  parser.

## Explicit non-goals

- No `--apply`, no quarantine writes and no physical deletion. Those need the
  cleanup lease, a fenced re-check of pins and index jobs, and delete handlers
  for both id spaces.
- No GC scheduler and no WebUI projection.
- No chunk GC. The Thai-RAG index owns semantic chunks.
- No repair of a refused plan; `index status` already reports the degraded
  state, and repair mutates.

## Verification

1. Unit: parse (dry-run in any position, missing dry-run, `--apply`, duplicate /
   unknown / positional args, sibling verbs), format (both id spaces, empty
   plan, refusal) and exit codes.
2. Workspace: `list()` spans trust boundaries; the dry-run report carries
   `unreachableArtifacts` while `quarantinedArtifacts` stays empty; a non-dry
   pass reports the same planned keys it quarantined.
3. CLI: dispatch (stdout, `--json`, usage exit `2`, unavailable exit `1`, thrown
   exit `1`) and the docs replay guard over `README.md`, `CLI_REFERENCE.md` and
   `USAGE_TH.md`.
4. Live: write a store with `index revision advance`, run `index gc --dry-run`
   and confirm the retained revision's content is `reachable` while an artifact
   with no retained binding is listed as `artifact-unreachable`, then confirm
   `quarantine/candidates.json` was not created.
