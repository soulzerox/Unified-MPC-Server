# Unified #210 slice — GC quarantine expiry plan (`index gc expire --dry-run`)

Issue: soulzerox/Unified-MPC-Server#210 (§7 revision refs, pins, prune, GC)
Depends on: U23 `expireGcQuarantine`, U21 `ArtifactQuarantineStore`, U28
`GcLeaseStore`, and the #623–#628 operator verbs (`status`, `revision list`,
`pin|unpin`, `prune`, `gc --dry-run`).
Status: plan-first, red-first implementation in this slice.

## Why this slice now

#628 made the quarantine plan visible, but the last step of the deletion flow is
still unit-test-only: `expireGcQuarantine` re-checks reachability and reports
which quarantined rows have passed grace. Without a caller, an operator can see
a row enter quarantine but cannot see whether it is due, stuck inside grace or
still live.

This slice exposes exactly the read-only half: the expire plan. Releasing rows
and calling the delete callbacks stay out because they mutate, need the U28
cleanup lease and a policy for the physical-delete callbacks.

## What lands

### 1. `apps/cli/src/commands/index-gc-expire.ts` (new module)

`parseIndexGcExpireArgs` parses `gc expire --dry-run [--json]`:

- `--dry-run` is **required**, not defaulted, because this is the most
  destructive GC step and the verb must not become a mutation by omission.
- `--apply` is rejected with a specific message (`--apply is not supported, only
  --dry-run`) so an operator learns the verb is read-only.
- Duplicate flags, unknown flags and positional arguments are `INVALID_INPUT`
  (exit `2`).

`formatIndexGcExpire(report)` prints:

```
planned (dry-run) expired <n> retained <n>
expire <content-hash>
expire <repository-id> <artifact-key>
retain <content-hash|repository-id artifact-key>
```

Both ledger id spaces are rendered: a bare id is a content hash, two ids are the
repository-scoped artifact row. A refused plan prints `refused <reason>`;
`indexGcExpireExitCode` maps a plan to `0` and a refusal to `1`.

### 2. CLI wiring (`apps/cli/src/index.ts`)

- `parseCliArgs` dispatches `index gc expire` before the plain `index gc` verb;
  the help gains one line.
- `CliDependencies.indexGcExpire({ dryRun: true })` returns `GcExpireReport`; the
  dispatch prints JSON or the operator lines and maps a missing dependency or
  thrown ledger error to exit `1`.
- `createDefaultCliDependencies` resolves `<dataPath>/canonical`, asserts storage
  identity, constructs refs/manifests/pins/overlays/quarantine/artifact stores
  plus `IndexJobLedger`, reads `liveManifestIds()` immediately before the pass,
  and passes `dryRun: true` with no lease and no delete callbacks.

### 3. Docs and guard

- `docs/CLI_REFERENCE.md` §9 gains the expire subsection after `gc --dry-run`,
  including the two id spaces, the re-check rule and the exit codes.
- `apps/cli/src/docs-examples.test.ts` gains the semantic expectation **before**
  the plain `index gc` pattern (otherwise the generic pattern would claim the
  example) and a replay dependency.

## Explicit non-goals

- No `--apply` and no delete callbacks. Releasing ledger rows and physically
  deleting artifacts need the cleanup lease, a callback policy per id space and
  their own tests.
- No lease renewal or scheduling. `expire` is an operator verb; the janitor
  (#80) and heavy-job scheduling (#145) own periodic runs.
- No repair of a refused plan; `index status` already reports the degraded
  state, and repair mutates.
- No `gc status` verb in this slice: the expire plan is the operational status
  of the quarantine ledger.

## Verification

1. Unit: parse (dry-run in any position, missing dry-run, `--apply`, duplicate /
   unknown / positional args, sibling `gc`/`gc status`/`revision` verbs), format
   (both id spaces, empty plan, refusal) and exit codes.
2. CLI: dispatch (stdout, `--json`, usage exit `2`, unavailable exit `1`, thrown
   exit `1`) and the docs replay guard over `README.md`, `CLI_REFERENCE.md` and
   `USAGE_TH.md`.
3. Live: quarantine a fixture row with a known deadline, run `index gc expire
   --dry-run` before and after the deadline, and confirm the row moves from
   `retain` to `expire` while `quarantine/candidates.json` and the artifact
   record still exist.
