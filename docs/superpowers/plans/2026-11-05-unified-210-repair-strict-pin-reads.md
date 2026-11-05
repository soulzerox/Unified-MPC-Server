# Unified #210 slice — strict pin reads in `index repair`

Issue: soulzerox/Unified-MPC-Server#210 (§7 revision refs, pins, prune and GC)
Follow-up: nonblocking review findings on #651 (`index repair` read orphan-pin
reasons with the tolerant registry reader, and the operator-pin contract comment
still claimed no CLI verb could remove a system-owned reason).
Status: plan-first, red-first implementation in this slice.

## Why this slice now

`repairCanonicalStore` classifies every pin before it mutates anything and
refuses a tolerant manifest store, so a corrupt manifest row can never look
absent. The pin evidence had the same shape of hole one layer down:

- the strict root listing accepted a pin file name case-insensitively, then the
  reasons were read back through `list()`, which lowercases the id first. On a
  case-sensitive filesystem the lowercased path does not exist, so the pin was
  planned with zero reasons, no reason was removed, and an apply reported
  `applied orphan-pins 0` with exit `0` while the store stayed degraded;
- a record that became unreadable between the strict listing and the reason
  read came back as `[]` for the same reason: `readAll` swallowed every error;
- `unpin` used the same tolerant read, so a record that turned unreadable
  during the apply could report "already gone" while the reason was still on
  disk.

The registry only writes lowercase canonical names, so a differently-cased
file is not legacy data this path must preserve; it is evidence a destructive
pass cannot prove.

## What lands

### 1. Strict pin reads in `packages/workspace`

`RevisionPinRegistry` gains the same `ReachabilityReadOptions` switch its
`pinnedManifestIds` listing already takes:

- `pinnedManifestIds({ strict: true })` refuses a pin file whose name is not the
  canonical lowercase manifest id (the tolerant listing still returns the raw id
  so `index status` can report it);
- `list(manifestId, { strict: true })` refuses an unreadable record, a record
  with no valid pin entries, and a record with some malformed entries. A
  missing file is still the legitimately empty case;
- `unpin(manifestId, reason, { strict: true })` uses the same strict read, so a
  record that becomes unreadable after classification cannot report success.

The tolerant default is unchanged for operator surfaces.

### 2. `repairCanonicalStore` uses the strict reads

Classification reads reasons with `list(..., { strict: true })` and each
removal uses `unpin(..., { strict: true })`. A non-canonical file name or an
unreadable record now refuses the pass instead of silently reporting a repaired
store. Classification still finishes before the first unpin; a record that
turns unreadable during the apply can leave earlier removals in place, which is
the same documented partial-pass behaviour as a lease loss.

### 3. Contract comment and docs

The `OPERATOR_PIN_REASON` comment and `docs/CLI_REFERENCE.md` now say the
pin/unpin verbs manage only `user-pin`, while `index repair` may remove every
reason after proving the manifest row is missing. The repair section documents
the strict pin-record refusal.

## Tests

1. Registry: a non-canonical file name refuses a strict listing but remains
   visible to the tolerant listing; a corrupt record refuses strict `list` and
   strict `unpin` while the tolerant calls keep their old answers; an empty or
   partly malformed record refuses a strict read, while a missing file stays
   the legitimately empty case.
2. Repair: a valid pin stored under an uppercase file name makes the pass reject
   with `cannot read revision pin` and leaves the pin file and the lease intact;
   a listing that yields an id whose record is unreadable also rejects at the
   reason read, so the `{ strict: true }` call site cannot be dropped silently.
3. Existing repair suites continue to cover the corrupt-manifest abort, strict
   root reads, lease refusal, idempotency and the retention change.

## Explicit non-goals

- No change to the pin registry format or to the canonical/tolerant defaults.
- No `index verify` verb in this slice; `index status` already reports the same
  verify report.
- No attempt to repair a non-canonical file name automatically: only a human
  can decide whether the record is the pin it claims to be.

## Verification

1. Targeted `vitest` for the registry and repair suites.
2. `tsc --noEmit` and `eslint` for `packages/workspace`.
3. Full `verify:local` on the exact head before the review capsule.
