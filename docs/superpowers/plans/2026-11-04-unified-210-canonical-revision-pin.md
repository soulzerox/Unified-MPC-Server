# Unified #210 slice — canonical revision pin / unpin verbs

Issue: soulzerox/Unified-MPC-Server#210 (§7 revision refs, pins, prune)
Depends on: U13 `RevisionPinRegistry`, U15 `CanonicalManifestStore`, and the
#622–#624 operator verbs (`advance`, `status`, `revision list`).
Status: plan-first, red-first implementation in this slice.

## Why this slice now

#624 made revision reachability inspectable: `index revision list` names every
store root that still holds each manifest. The next verb in §7 must make the
operator-owned root **writable**, because `pruneRevisionManifests` already
refuses a pinned revision and there is no supported way to create that pin from
the CLI.

Pin before prune is deliberate. A prune verb that lands first would be the only
mutation an operator can perform on a revision, and its only safety input —
pins — would be unreachable except through tests.

## What lands

### 1. `packages/workspace/src/canonical-revision-pin.ts` (new, deep module)

`pinCanonicalRevision({ manifests, pins }, { manifestId, note })`:

- requires the manifest to exist (`unknown revision manifest` otherwise) so the
  command cannot create an orphan pin that store verify would report degraded;
- writes only `OPERATOR_PIN_REASON = 'user-pin'`, never a system-owned reason;
- is idempotent: re-pinning refreshes note/timestamp without duplicating;
- returns the manifest id, `action: 'pinned'` and every remaining pin reason.

`unpinCanonicalRevision(...)`:

- removes only `user-pin`, leaving `canonical-ref`, `goal-base`, `goal-overlay`,
  `index-job` and `rollback` untouched;
- does **not** require the manifest to exist, so an orphan pin left by an older
  build has a supported repair;
- is idempotent: `not-pinned` when there is nothing to remove, still exit 0;
- returns the remaining pin reasons so an operator sees the revision is still
  held by a system root.

The operator-reason restriction is the slice's safety argument: a CLI that could
unpin `canonical-ref` would delete reachability evidence while a live ref still
depends on the revision, which is exactly the failure prune must prevent.

### 2. `apps/cli/src/commands/index-revision-pin.ts` (+ `index revision pin|unpin`)

- Parses `revision pin|unpin <manifest-id>` with `--json`; `--note` is pin-only.
- Validates the manifest-id shape at parse time, so a typo is exit `2`, while a
  well-formed but unknown id is exit `1` from the module.
- Duplicate ids/flags, unknown flags, `--note` without a value, and `--note` on
  unpin are `INVALID_INPUT`.
- Prints `pinned <id> reason user-pin` / `unpinned <id>` / `not-pinned <id>`,
  then `pins <reasons|none>`.

`parseCliArgs` grows the `pin|unpin` sub-dispatch; the default dependency
resolves the same `<dataPath>/canonical` root as `advance`, `status` and
`revision list`, and asserts storage identity first.

### 3. Docs and guard

`docs/CLI_REFERENCE.md` §9 gains both subsections after `index revision list`;
`apps/cli/src/docs-examples.test.ts` gains the two semantic expectations and a
replay dependency, so the documented command lines cannot drift from the parser.

## Explicit non-goals

- No `index revision prune` / `gc` / `repair`. Those delete and need their own
  safety argument; this slice only creates the operator-owned root prune will
  consult.
- No `--reason` flag. A later slice may add one only with an owner-checked
  allowlist; today the CLI manages `user-pin` alone.
- No WebUI projection and no automatic advance seam.

## Verification

1. Unit: pin existing / re-pin note refresh / system reasons untouched /
   unknown manifest refused with no pin written / malformed id refused; unpin
   only operator reason / `not-pinned` / orphan-pin cleanup.
2. CLI: parse (pin, note, unpin, case normalization, every rejection), format
   (pinned, unpinned-none, not-pinned-remaining), dispatch (stdout, `--json`,
   usage exit 2, unavailable exit 1, thrown exit 1) and the docs replay guard.
3. Live: pin and unpin a manifest from a store written by `index revision
   advance`, and confirm `index revision list` shows the `user-pin` reason
   appear and disappear while `index status` counts it.
