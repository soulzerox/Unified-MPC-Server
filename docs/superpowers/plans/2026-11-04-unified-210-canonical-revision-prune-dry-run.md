# Unified #210 slice — canonical revision prune plan (`--dry-run`)

Issue: soulzerox/Unified-MPC-Server#210 (§7 revision refs, pins, prune)
Depends on: U20 `pruneRevisionManifests`, U13 `RevisionPinRegistry`, U15
`CanonicalManifestStore`, `IndexJobLedger.liveManifestIds`, and the
#622–#626 operator verbs (`advance`, `status`, `revision list`, `pin|unpin`).
Status: plan-first, red-first implementation in this slice.

## Why this slice now

#624 made revision reachability inspectable and #626 made the operator-owned
root writable, so every input `pruneRevisionManifests` consults is now reachable
from the CLI. The planner itself already shipped in U20 and is only exercised by
unit tests, which means an operator cannot see what a prune would do.

This slice exposes exactly the read-only half: the plan. Deletion stays out
because the #626 review found the pin registry is an unlocked read-modify-write
and the planner snapshots pins before it deletes. A concurrent `pin` landing
after that snapshot would be ignored by a delete pass; a dry-run plan can be
stale, but it cannot lose data.

## What lands

### 1. `apps/cli/src/commands/index-revision-prune.ts` (new module)

`parseIndexRevisionPruneArgs` parses `revision prune --dry-run [--json]`:

- `--dry-run` is **required**, not defaulted. The verb exists to inspect a plan,
  and requiring the flag keeps a future apply from being the default of an
  already-documented command.
- `--apply` is rejected with a specific message (`--apply is not supported, only
  --dry-run`) so an operator who guessed the next flag learns the verb is
  read-only instead of assuming the printed plan was enforced.
- Duplicate flags, unknown flags and positional arguments are `INVALID_INPUT`
  (exit `2`).

`formatCanonicalRevisionPrune(report)` prints:

```
planned (dry-run) pruneable <n> retained <n>
prune <manifest-id>
retain <manifest-id> <canonical-ref|pin|overlay-base|index-job>
```

The header says `dry-run` because the module only ever builds a dry-run report;
a later apply verb must render removals explicitly rather than reuse this line.

### 2. CLI wiring (`apps/cli/src/index.ts`)

- `parseCliArgs` dispatches `index revision prune`; the sibling usage string
  lists `prune`.
- `CliDependencies.indexRevisionPrune({ dryRun: true })` returns
  `RevisionPruneReport`; the dispatch prints JSON or the operator lines and maps
  a missing dependency / thrown store error to exit `1`.
- `createDefaultCliDependencies` resolves `<dataPath>/canonical`, asserts storage
  identity, constructs refs/manifests/pins/overlays plus `IndexJobLedger`, reads
  `liveManifestIds()` immediately before planning, and passes `dryRun: true`
  unconditionally.
- Help gains one line: `index revision prune --dry-run`.

### 3. Docs and guard

- `docs/CLI_REFERENCE.md` §9 gains the prune subsection after `unpin`, including
  the "plan is advisory" warning and the exit codes.
- `apps/cli/src/docs-examples.test.ts` gains the semantic expectation and a
  replay dependency, so the documented command line cannot drift from the
  parser.

## Explicit non-goals

- No `--apply`, `--force` or `gc`. Deletion needs a fence that re-checks pins
  and index jobs under the same lock that removes the manifest; that is its own
  slice with its own tests.
- No repair of orphaned pins, dangling refs or missing overlay bases. `index
  status` already reports them; repair mutates and needs its own argument.
- No WebUI projection and no automatic prune scheduled task.

## Verification

1. Unit: parse (dry-run in any position, missing dry-run, `--apply`, duplicate /
   unknown / positional args, sibling verbs) and format (plan lines, empty plan).
2. CLI: dispatch (stdout, `--json`, usage exit `2`, unavailable exit `1`, thrown
   exit `1`) and the docs replay guard over `README.md`, `CLI_REFERENCE.md` and
   `USAGE_TH.md`.
3. Live: write a store with `index revision advance`, confirm the plan lists the
   previous revision as `prune` and the current one as `retain canonical-ref`,
   then pin the stale revision and confirm it moves to `retain pin` without any
   file being deleted.
