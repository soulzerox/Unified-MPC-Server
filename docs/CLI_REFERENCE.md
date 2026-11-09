# Unified-MPC CLI Reference Manual

The `unified-mpc` command-line interface provides comprehensive control over the server, dynamic ingestion, policy synchronization, and tool execution.

```bash
# Usage
unified-mpc <command> [subcommand] [flags]
```

---

## 1. System Commands

### `unified-mpc status`
Prints the number of registered workspaces. For diagnostics, use `doctor`.
```bash
$ unified-mpc status
workspaces: 1
```

### `unified-mpc doctor`
Runs the operational diagnostics the runtime itself depends on: operating system, the SQLite core database, Git, ripgrep, the workspace registry, the HTTP MCP port, and Codex. It prints one `[STATUS] id: message` line per check and exits non-zero when a required check fails.

Required checks are `os`, `database`, `ripgrep`, and `mcp-port`. `git`, `workspaces`, and `codex` are informational: missing Git, a clean profile without a registered project, or no Codex install is reported as `WARN` without failing the command. A port already held by the running server is also a `WARN`, so `doctor` stays usable while Unified-MPC is up.
```bash
$ unified-mpc doctor
[PASS] os: linux x64 (6.8.0-1018-azure)
[PASS] database: Unified MCP core operational
[PASS] git: Git ready (/usr/bin/git)
[PASS] ripgrep: ripgrep ready (/usr/bin/rg)
[PASS] workspaces: 1 workspace configured
[WARN] mcp-port: MCP port 18765 is already in use
[WARN] codex: Codex is not installed
```

---

## 2. Dynamic Ingestion Commands

### `unified-mpc install skill`
Installs an Agent Skill package from a directory or git repository into target IDE skill directories without spawning background daemons.
```bash
# Syntax
unified-mpc install skill <name> <source-path> [--targets <target1,target2,...>] [--scope global|workspace] [--workspace <path>]

# Example: Install skill globally for Antigravity and Cursor
unified-mpc install skill agy-customizations /path/to/skill --targets antigravity,cursor

# Example: Install skill into workspace .gemini/skills/
unified-mpc install skill local-helper /path/to/skill --workspace /home/user/project
```

The install name must match the `name:` declared in the skill's `SKILL.md`
frontmatter. A mismatch is rejected with `CONFLICT` (`reason:
skill-name-conflict`) so the canonical catalog cannot advertise one logical
Skill under two IDs (issue #294).

### `unified-mpc install server`
Installs and registers an executable MCP Server into target IDE configurations.
```bash
# Syntax (stdio transport)
unified-mpc install server <name> --transport stdio --command <cmd> [--args <arg1,arg2,...>] [--env <KEY=VAL,...>] [--targets <targets>]

# Syntax (SSE or HTTP transport)
unified-mpc install server <name> --transport sse --url <http://endpoint:port/sse> [--targets <targets>]

# Example: Install SQLite MCP server
unified-mpc install server sqlite --transport stdio --command uvx --args mcp-server-sqlite,--db,app.db --targets cline,opencode
```

---

## 3. Zero-Artifact Pruning Commands

### `unified-mpc prune skill`
Removes an installed skill across target IDE directories and clears residual directories.
```bash
# Syntax
unified-mpc prune skill <name> [--targets <targets>] [--scope global|workspace] [--workspace <path>]

# Example
unified-mpc prune skill local-helper --workspace /home/user/project
```

### `unified-mpc prune server`
Terminates running server child processes (`SIGTERM` -> `SIGKILL`) and purges entries from all IDE config files.
```bash
# Syntax
unified-mpc prune server <name> [--targets <targets>] [--scope global|workspace] [--workspace <path>] [--no-kill]

# Example
unified-mpc prune server sqlite --targets cline,opencode
```

Data purge moves approved paths into Recovery Trash before success. Successful results include `recoveryStatus: "completed"` and `recoveryIds`; later failure reports `recoveryStatus` as `partial` or `rollback_failed`.

---

## 4. Policy Synchronization Command

### `unified-mpc sync`
Compiles the persisted user-editable P1–Pn runtime policy and synchronizes it idempotently into all connected IDE rule files. Semantic policy IDs remain stable when users reorder execution positions.
```bash
# Syntax
unified-mpc sync [--targets <t1,t2,...>] [--workspace <path>]

# Supported targets: antigravity, cursor, claude, opencode, cline, omp, codex, all (default: all)

# Example: Synchronize policy across all clients in workspace
unified-mpc sync --workspace /home/user/my-project
```

---

## 5. Web Control Plane Command

### `unified-mpc web`
Launches the local reactive Web Control Plane SPA daemon on loopback HTTP.
```bash
# Syntax
unified-mpc web [--port <number>]

# Default: http://127.0.0.1:3000/
unified-mpc web --port 3000
```

---

## 6. Headless Tool Execution Commands

### `unified-mpc tools list`
Prints one tab-separated `name<TAB>description` line per available downstream tool.
```bash
$ unified-mpc tools list
read_file	Read file contents
tool_categories	List tool categories
```

### `unified-mpc tools call`
Directly invokes any registered tool headlessly from terminal scripts or non-MCP agents.
```bash
# Syntax
unified-mpc tools call <tool-name> '<json-arguments>'

# Example
$ unified-mpc tools call tool_categories '{}'
{
  "categories": [ ... ]
}
```

---

## 7. Publish Credential Commands

The operator surface for the host-owned HTTP(S) publish credential (#297). The
secret is read from stdin only, never from argv or the environment. Grant
requires a promoted release; see
[PUBLISH_CREDENTIAL_RUNBOOK.md](PUBLISH_CREDENTIAL_RUNBOOK.md) for rotation and
emergency revocation.

```bash
# Grant one short-lived lease. The command prompts without echo on a TTY.
unified-mpc publish-credential grant <remote> \
  --workspace <id-or-path> --username <user> --ttl <seconds>

# Revoke a lease (idempotent). Removes the Secret Service entry first, then
# tombstones the row. An id that was never granted is refused with no audit row.
unified-mpc publish-credential revoke <leaseId>

# Show lease metadata and state without the secret.
unified-mpc publish-credential status <leaseId>
```

Every `publish-credential` command first sweeps leases whose TTL has passed, so
a lease that already expired usually has no row left: `revoke` exits 1 with
`publish-credential-not-found`, and `status` prints `publish credential not
found` and exits 0. `status` can still report `state: expired` for a row that
outlived its TTL, for example when the sweep could not delete its secret, and
`revoked` for a lease revoked before its TTL.

`grant` writes a `publish_credential_grant` audit row, `revoke` writes
`publish_credential_revoke` with result code `SUCCESS`, or `UNVERIFIED` when the
secret was deleted but the lease could not be read back or marked revoked (and
also when the Secret Service delete itself failed), and a credential-bound
publish writes
`publish_credential_use`. The audit rows carry lease metadata only; the secret
never enters them.

---

## 8. Storage Commands

Operator surface for the SQLite file that backs the workspace registry, audit log,
settings and goal runtime. Both commands print their report on stdout; a failure
prints on stderr and exits `1`.

### `unified-mpc storage recover`

Replaces the canonical database with one unambiguous historical SQLite file, for
example after an interrupted upgrade left the runtime reading an empty store.

```bash
$ unified-mpc storage recover
storage recovery not needed
```

When a historical database is present, the command names the source it moved
aside, the destination now in use, and the provenance record it wrote:

```text
storage recovered: /home/operator/.local/share/unified-mpc/legacy.sqlite -> /home/operator/.local/share/unified-mpc/unified-mpc.sqlite
provenance: /home/operator/.local/share/unified-mpc/recovery/provenance.json
```

Recovery refuses to act when more than one candidate matches, or when the
canonical database became populated after the replacement decision, so a rerun
cannot merge two unrelated histories. `storage recovery not needed` is a success
with exit `0`, not a skipped failure.

### `unified-mpc storage metrics [--json]`

Reports physical space for the canonical database. Logical GC deletes rows and
never shrinks the file, so these numbers keep "rows gone" and "bytes reclaimed"
apart.

```bash
$ unified-mpc storage metrics
database	/home/operator/.local/share/unified-mpc/unified-mpc.sqlite
bytes	db=4116480 wal=0 shm=32768 live=3317760
pages	size=4096 count=1005 freelist=195 (798720 bytes, 0.1940)
checkpoint	mode=passive busy=false walPages=0 checkpointedPages=0 truncated=false
compaction	recommended=false reason=none
```

`--json` prints the unprojected metrics document instead of the operator lines:

```bash
$ unified-mpc storage metrics --json
{"measuredAt":"2026-11-04T00:00:00.000Z","inMemory":false,"databasePath":"/home/operator/.local/share/unified-mpc/unified-mpc.sqlite","databaseBytes":4116480,"walBytes":0,"shmBytes":32768,"pageSizeBytes":4096,"pageCount":1005,"freelistCount":195,"freelistBytes":798720,"liveBytes":3317760,"freelistRatio":0.19402985074626866,"checkpoint":{"mode":"passive","busy":false,"walPages":0,"checkpointedPages":0,"truncated":false},"compactionRecommended":false,"compactionReason":null}
```

Any other flag is refused with the usage line and exit `2`, so a typo cannot
silently become a report nobody asked for. The command is evidence only: it never
vacuums, truncates or checkpoints destructively. `compaction.recommended` flips
to `true` only when the freelist is both at least 25% of the file and at least
64 MiB, and `reason` then names the measured bytes, ratio and thresholds.
Compaction itself stays a separate bounded maintenance step under the existing
owner fence.

---

## 9. Canonical Revision Index

Operator surface for the content-addressed canonical store (#210): refs,
revision manifests and file artifacts under `<dataPath>/canonical`. The command
never fetches, so run `git fetch` first — recording an advance to a commit the
ref does not actually point at would make the manifest lie.

### `unified-mpc index revision advance [--ref <ref>] [--repository-id <id>] [--json]`

Resolves the exact commit `--ref` points at (default `refs/remotes/origin/main`),
reads that commit's **Git tree** — not the worktree — hashes every blob, and runs
the advancement gate: classify the delta against the active manifest, persist the
manifest, compare-and-swap the ref, then register the manifest's entries as
content-addressed file artifacts.

```bash
$ unified-mpc index revision advance
canonical refs/remotes/origin/main: promoted
commit 4d1c0a1f8b25e0e4c9a7b3d2f6a1c8e09b7d5f21
tree 7a3f9c1e2d4b6a8f0c5e7d9b1a3f5c7e9d0b2a4c
manifest man:v1:3c9f1e7a5d2b8c4f6a0e2d4c8b6a4f2e0d8c6b4a2f0e8d6c4b2a0f8e6d4c2b0a
repository repo:v1:5b2e8c0a4f6d2b8e0c4a6f8d2b4e6c8a0f2d4b6e8c0a2f4d6b8e0c2a4f6d8b0e
reuse reused=1063 new=3 renamed=0 deleted=0
artifacts reused=890 registered=3 unclassified=173
```

- `reuse reused=…` is the §3 evidence that unchanged paths were *reused*, not
  re-embedded; `renamed=…` counts paths whose content moved to a new path and
  therefore demanded no new artifact.
- `artifacts registered=…` counts only artifacts this pass actually created, so
  a rerun reports `registered=0` and the same `reused=…`. `unclassified=…` counts
  manifest paths the source policy does not classify (binary assets, lockfiles);
  they are reported, never claimed as indexed.
- The command refuses, before writing anything, an unresolvable ref, a tree entry
  that is not a blob (a submodule gitlink has no decided semantics yet), a
  content hash that is not an exact SHA-256, or a repository with no remote and no
  `--repository-id`.
- `--repository-id` pins the trust boundary instead of deriving it from the
  remote URL. Reuse is never claimed across boundaries, so changing it starts a
  new, empty artifact namespace.
- A conflict (another writer advanced the same ref during the pass) and a
  refusal both exit `1`; so does a promotion whose artifact registration was
  refused, because that store is durable but incomplete.

`--json` prints the unprojected report instead of the operator lines:

```bash
$ unified-mpc index revision advance --json
{"status":"noop","repositoryId":"repo:v1:5b2e","targetRef":"refs/remotes/origin/main","commitSha":"4d1c0a1f8b25","gitTreeOid":"7a3f9c1e2d4b","unifiedTreeOid":"9f0e…","revisionId":"rev:v1:…","manifestId":"man:v1:…","reuse":{"reusedPaths":["src/a.ts"],"newPaths":[],"renamedPaths":[],"deletedPaths":[]},"artifacts":{"status":"registered","registered":0,"reused":1,"unclassified":[]}}
```

Exit code `0` means the ref is at that revision and every classified entry has an
artifact record; `1` means the store needs attention; `2` means the arguments
were not understood.

### `unified-mpc index revision list [--json]`

Read-only listing of the revision manifests the store holds, newest first, with
every store root that still references each one: canonical refs, pin reasons,
Goal overlay bases, unsettled index jobs and live Thai-RAG provider
generations.

```bash
$ unified-mpc index revision list
revisions 2
  man:v1:3c9f1e7a5d2b commit 4d1c0a1f8b25 tree 7a3f9c1e2d4b entries 695 created 2026-11-04T00:00:00.000Z
    refs refs/remotes/origin/main
  man:v1:9b1c4f2e7a60 commit 261b4942fe79 tree 5e2a7c9d1b30 entries 692 created 2026-10-30T00:00:00.000Z
    pins rollback
    index-jobs op_reindex
    provider-generations 9628fc78-f52f-428e-b358-bbfb66037150
```

- One summary line per revision: manifest id, commit, Git tree OID, entry count
  and creation time.
- Detail lines appear only when a store still holds the revision: `refs` (ref
  names), `pins` (pin reasons), `overlay-bases` (Goal workspace ids),
  `index-jobs` (operation ids) and `provider-generations` (workspace ids whose
  live Thai-RAG generation was built from the manifest). A revision with no
  detail lines is referenced by nothing — the state a later prune slice would
  collect.
- This is a report, not a health verdict: an empty store prints `revisions 0`
  and exits `0`, and the command never mutates the store.
- Exit `0` for any successful read; `1` when the store cannot be read; `2` for
  arguments that are not `list` plus an optional `--json`.

### `unified-mpc index revision pin <manifest-id> [--note <text>] [--json]`

Adds the operator pin (`user-pin`) to one stored revision. A pin is
reachability evidence for revision prune and artifact GC, not a deletion: a
pinned manifest is reported as a blocking reason and left alone.

```bash
$ unified-mpc index revision pin man:v1:3c9f1e7a5d2b8c4f6a0e2d4c8b6a4f2e0d8c6b4a2f0e8d6c4b2a0f8e6d4c2b0a --note "keep for audit"
pinned man:v1:3c9f1e7a5d2b8c4f6a0e2d4c8b6a4f2e0d8c6b4a2f0e8d6c4b2a0f8e6d4c2b0a reason user-pin
pins user-pin
```

- The command only ever writes `user-pin`. Other reasons (`canonical-ref`,
  `goal-base`, `goal-overlay`, `index-job`, `rollback`) are owned by the store
  that depends on the revision and are never touched by the pin/unpin verbs;
  `index repair` may remove them only when the manifest row is missing
  (see below).
- A well-formed id whose manifest is not stored is refused (`unknown revision
  manifest`) instead of leaving an orphan pin the store verify path would report
  as degraded.
- The pin takes the same single-owner GC lease as `index revision prune` and
  `index gc`, so under that fence it cannot land in the window between a
  prune's pin snapshot and its manifest delete. The lease is a single-host
  read-then-write record rather than an atomic compare-and-swap, so two
  simultaneous acquirers can both be granted; that residual window is inherited
  from the lease primitive. A destructive pass that already holds the lease
  refuses the pin with `gc lease held by ...`; retry after it finishes. The
  manifest is re-read under the fence, so a revision pruned before the pin is
  refused rather than pinned as an orphan.
- Re-pinning refreshes the note and timestamp; the reason is not duplicated.

### `unified-mpc index revision unpin <manifest-id> [--json]`

Removes only the operator pin. Every remaining reason is printed, so a revision
that is still held by a canonical ref or a Goal base is visibly not collectible.

```bash
$ unified-mpc index revision unpin man:v1:3c9f1e7a5d2b8c4f6a0e2d4c8b6a4f2e0d8c6b4a2f0e8d6c4b2a0f8e6d4c2b0a
unpinned man:v1:3c9f1e7a5d2b8c4f6a0e2d4c8b6a4f2e0d8c6b4a2f0e8d6c4b2a0f8e6d4c2b0a
pins none
```

- Unpinning is idempotent: when no operator pin exists the command prints
  `not-pinned` and the remaining reasons, and still exits `0`.
- The manifest does not have to exist. Unpinning a revision whose manifest was
  already deleted cleans up an operator orphan pin, so this command remains the
  narrow repair when only the `user-pin` reason is in the way. `index repair`
  removes every reason from an orphan pin while its manifest stays missing
  (see below).
- Exit `0` for any successful pin or unpin; `1` when the manifest is unknown,
  the GC lease is held or unreadable, or the store cannot be written; `2` for
  arguments that are not `pin|unpin` plus one manifest id and an optional
  `--note` (pin only) or `--json`.

### `unified-mpc index revision prune --dry-run|--apply [--json]`

Plans or executes the prune of revision manifests: every stored revision that no
canonical ref, pin, Goal overlay base, unsettled index job or live Thai-RAG
provider generation still holds. Exactly one mode is required rather than
defaulted.

```bash
$ unified-mpc index revision prune --dry-run
planned (dry-run) pruneable 1 retained 2
prune man:v1:9b1c4f2e7a60
retain man:v1:3c9f1e7a5d2b canonical-ref
retain man:v1:ff0371d8c4e2 pin
retain man:v1:6a2b3c4d5e6f provider-generation
```

- `--dry-run` prints `prune` candidates and never writes. `--apply` takes the
  single-owner GC lease and re-reads refs, pins, overlay bases and manifest rows
  inside the fenced pass, deleting only the manifests that are still
  unreachable, so a `pin` or `advance` created after the plan is retained. The
  index-job and provider-generation ledgers are snapshotted immediately before
  the pass takes the lease, the same pre-fence window `index gc --apply` and
  `index gc expire --apply` accept. The lease window is renewed as the pass
  deletes, so a long prune cannot silently outlive its fence.
- Only revision manifest JSON is deleted. Content-addressed artifacts are shared
  and stay with artifact GC, which re-checks reachability after quarantine.
- An apply prints `applied pruneable N removed N retained N`, then one
  `removed <id>` line per deleted manifest and the `retain` lines. A refused
  pass prints `refused <reason>`: another owner holds the lease, the fence
  record is unreadable, the index-job or provider-generation ledger cannot be
  read, or the pass ran without a lease.
- A manifest row that exists but cannot be deleted fails the pass with the
  failing path in the error, so `removed` never claims a row that is still on
  disk.
- `retain` lines name why the planner kept a revision: `canonical-ref`, `pin`,
  `overlay-base`, `index-job` or `provider-generation`.
- A plan with nothing to collect prints `planned (dry-run) pruneable 0 retained N`
  and still exits `0`.
- A pin that lands while `--apply` holds the lease is refused (`gc lease held by
  ...`), because the pin takes the same fence the pass holds; a pin that lands
  before the pass takes the lease is visible to its registry snapshot. Apart
  from the lease's inherited double-grant race, the pin and the pass cannot
  interleave in the snapshot/delete window.
- Exit `0` for a plan or a completed pass; `1` when the pass refuses, the store
  cannot be read, or a manifest cannot be deleted; `2` when neither mode, both
  modes, or another argument is given.

### `unified-mpc index repair --dry-run|--apply [--json]`

Plans or removes the one degraded state the store can safely repair on its own:
a revision pin whose manifest row is missing. While the row stays missing, every
reason on that pin is removed; because the row is re-checked before each
removal, a manifest re-created mid-pin keeps its remaining reasons. Exactly one
mode is required rather than defaulted.

```bash
$ unified-mpc index repair --dry-run
planned (dry-run) orphan-pins 1
repair man:v1:9b1c4f2e7a60 user-pin
dangling-refs 0
missing-overlay-bases 0
```

- `--dry-run` prints `repair` lines for the orphan pins it would remove and
  never writes or takes the GC lease. `--apply` takes the single-owner GC lease
  and removes reasons from those pins under it, renewing the lease as it
  removes.
- A pin is only removed when its manifest is genuinely missing. The manifest
  store is strict-read (a tolerant store is refused), so a corrupt manifest row
  aborts the pass with nothing removed instead of looking like a missing row.
  Classification of every pin finishes before the first unpin, and the row is
  re-checked immediately before each unpin, so a row re-created mid-pin keeps
  the remaining reasons instead of losing them. A lease loss or write failure
  after removals begin can leave those removals in place; re-running is
  idempotent.
- Pin records are read strictly too. An unreadable record, a record with no
  valid pin entries, or a file name that is not the canonical lowercase
  manifest id refuses the pass, because reading the reasons from the lowercased
  path would otherwise look like "no reasons" and report `applied orphan-pins
  0` while the pin still degrades the store. The record is read strictly again
  before each reason is removed.
- Removing an orphan pin is deliberately not reachability-neutral: artifact-key
  GC treats every pin id as retention evidence, and `assembleGcRoots` refuses
  the whole pass while a pinned manifest is missing. The repair releases
  artifacts bound only to the missing manifest to the normal GC grace window
  and unblocks GC. No live ref, overlay or index job can reach those bindings.
- The lease acquire is read-then-write, like revision prune, so the
  single-owner guarantee has the same narrow double-grant window documented
  there.
- `dangling-refs` and `missing-overlay-bases` are reported, never deleted. A
  dangling ref must be re-advanced by its owning revision gate, and a Goal
  overlay with a missing base still holds dirty state; deleting either would
  discard evidence or uncommitted work.
- An apply prints `applied orphan-pins N` and one `removed <id> <reasons>` line
  per pin from which it removed at least one reason, listing only the reasons it
  removed. A pin re-created before its first removal is absent; a pin re-created
  mid-removal still appears with just the reasons already removed. A refused
  pass prints `refused <reason>`: another owner holds the lease, the fence
  record is unreadable, or the pass ran without a lease.
- Exit `0` only when the store is healthy after the plan or pass. It exits `1`
  for a refusal, for an unreadable store, or when dangling refs or missing
  overlay bases remain, so a repair that cannot fully heal the store is visible
  to scripts.
- `2` when neither mode, both modes, or another argument is given.

### `unified-mpc index gc --dry-run|--apply [--grace <duration>] [--json]`

Plans the artifact GC cycle: the content hashes and repository-scoped artifact
keys reachable from every retained revision (canonical refs, pins, Goal overlay
bases, unsettled index jobs, live Thai-RAG provider generations), and the ones
no retained revision references.
`--dry-run` prints that plan; `--apply` writes the unreachable set to the
quarantine ledger under the single-owner cleanup lease. Exactly one mode is
required rather than defaulted, so the verb never becomes a mutation by
omission.

```bash
$ unified-mpc index gc --dry-run
planned (dry-run) reachable 693 unreachable 2 artifact-unreachable 2
unreachable 9b1c4f2e7a60
unreachable ff0371d8c4e2
artifact-unreachable repo:v1:documented file:v1:9b1c4f2e7a60
artifact-unreachable repo:v1:documented file:v1:ff0371d8c4e2
```

- `unreachable` lines are content hashes and `artifact-unreachable` lines carry
  the owning repository, because an artifact key is only resolvable inside one
  trust boundary. The same content can appear in both id spaces.
- Chunk artifacts are excluded. The Thai-RAG index owns semantic chunks and the
  artifact-key planner only reads file bindings, so listing them here would mark
  every chunk collectible.
- A refusal (no reachability roots, a root manifest missing on disk, no
  artifact reachability evidence, an artifact record, index-job ledger or
  provider-generation ledger that cannot be read) prints `refused <reason>` and
  exits `1`: a GC plan that cannot prove reachability must not look like an
  empty plan. A skipped corrupt record would hide both a candidate and the
  bindings that keep live artifacts reachable.
- The plan is advisory: a concurrent `advance`, `pin` or index job can change
  reachability, so re-run it before acting on it.
- Exit `0` for any plan; `1` when the plan is refused or the store cannot be
  read; `2` when neither mode is given, both are given, or another argument is
  unknown.

### `unified-mpc index gc --apply [--grace <duration>] [--json]`

The mutating pass. Takes the GC lease, re-plans against the roots it reads at
that moment, and appends the unreachable content hashes and artifact keys to the
quarantine ledger with one shared grace deadline. Existing rows keep their
original quarantine time, so re-running the pass never extends a deadline.

```bash
$ unified-mpc index gc --apply --grace 7d
applied quarantined 2 artifact-quarantined 2
quarantined 9b1c4f2e7a60
quarantined ff0371d8c4e2
artifact-quarantined repo:v1:documented file:v1:9b1c4f2e7a60
artifact-quarantined repo:v1:documented file:v1:ff0371d8c4e2
```

- `--grace` sets the quarantine window: `<n><s|m|h|d>`, default `7d`, zero
  rejected. Nothing is deleted here; `index gc expire` is the step that
  releases due rows after a reachability re-check. A window that would place
  the deadline outside the range a date can represent is refused instead of
  writing a row that can never expire.
- A dry run does not accept `--grace`: it stamps no deadline.
- A held or unreadable lease prints `refused gc lease ...` and exits `1` before
  anything is written. Concurrent passes therefore cannot quarantine from two
  reachability snapshots at once. The window is renewed while the pass is still
  planning or writing, so a long cycle cannot let the fence expire underneath
  it.
- Exit `0` when the pass wrote its plan; `1` when it is refused; `2` for a usage
  error.

### `unified-mpc index gc expire --dry-run|--apply [--json]`

Plans or performs the deletion step for the quarantine ledger: rows whose grace
deadline has passed and that are still unreachable when reachability is
re-checked now, plus the rows retained because they are still inside grace or
became reachable again. Exactly one mode is required: this is the destructive
step, so it must not become a mutation by omission.

```bash
$ unified-mpc index gc expire --dry-run
planned (dry-run) expired 2 retained 1
expire 4d1c0a1f8b25
expire repo:v1:documented file:v1:9b1c4f2e7a60
retain repo:v1:documented file:v1:ff0371d8c4e2
```

- `expire` rows are release-and-delete candidates, not deletions.
- A bare id is a content hash; a repository plus artifact key is the
  repository-scoped artifact row.
- Reachability is re-checked in this pass, so an artifact that became live again
  after quarantine is `retain`ed even after its deadline. A refused plan (no
  reachability roots, a root manifest missing on disk, an unreadable ref/pin/
  overlay/index-job/provider-generation ledger, or an artifact record that
  cannot be read) prints `refused <reason>` and exits `1`; nothing is released.
- Exit `0` for any plan; `1` when the plan is refused or the ledger cannot be
  read; `2` when neither mode is given, both are given, or another argument is
  unknown.

#### `unified-mpc index gc expire --apply [--json]`

The destructive pass. Takes the GC lease, re-checks reachability, then releases
every due row and calls the delete callbacks before removing it from the ledger.

```bash
$ unified-mpc index gc expire --apply
applied due 2 released 2 retained 1
released 4d1c0a1f8b25
released repo:v1:documented file:v1:9b1c4f2e7a60
retain repo:v1:documented file:v1:ff0371d8c4e2
```

- Artifact-key rows delete the canonical artifact record (the store's physical
  delete). Content-hash rows release the ledger entry only: the canonical store
  holds no content-addressed bytes — Git owns the file content — so there is
  nothing else to delete.
- A row whose grace deadline cannot be placed on the timeline is retained, not
  deleted: `index gc status` reports the same row as `until unreadable`, so a
  destructive pass that expired it would contradict the read-only surface. Such
  a row can never become due, so an operator has to remove it from
  `quarantine/candidates.json`; `index gc --apply` refuses a `--grace` window
  that would stamp one, so a build with that check cannot create the state. A
  store written by an older build that accepted such a window can still carry
  these rows across the upgrade.
- A record delete that fails for any reason other than "already gone" aborts the
  pass: the row stays in the ledger, `failed to delete canonical artifact ...`
  reports the key, the repository and the cause, and the lease is still
  released. An already-missing record is a no-op, so re-running converges.
- A ledger that cannot be read (permission error, corrupt JSON, non-array
  document) exits `1` instead of being reported as an empty ledger: `due 0` must
  never stand in for "the ledger is unreadable".
- Reachability roots and artifact records are read strictly: a ref, pin,
  overlay, index-job or provider-generation ledger file, or an artifact record,
  that cannot be read refuses the pass instead of being dropped. A dropped root
  or binding would make live artifacts look unreachable and get them deleted.
- A due artifact-key row without a wired record delete refuses the pass: the
  row is never released as "deleted" while its record survives.
- A held or unreadable lease prints `refused gc lease ...` and exits `1` before
  anything is released. The lease is released afterwards even when the pass
  refuses partway, and its window is renewed at each delete, so a long pass
  cannot silently outlive its fence. A pass that loses the fence to a newer
  generation stops before the next delete. Artifacts deleted before the abort
  stay deleted, and every due row stays in the ledger because the ledger is
  released only after the whole delete loop, so a retry re-processes the due
  set (an already-deleted record is a no-op).
- Retained rows stay in the ledger, so a later run can delete them once their
  deadline passes or their reachability is settled. That does not hold for a row
  whose deadline is unreadable: it is retained forever, as described above.
- Exit `0` when the pass applied; `1` when it is refused or the ledger cannot be
  read; `2` for a usage error.

### `unified-mpc index gc status [--json]`

Read-only snapshot of the two inputs that decide whether a destructive pass is
safe right now: the GC lease record and the quarantine ledger. It never takes
the lease, never releases a row and never judges reachability, so it is safe to
run at any time, including while a pass is running.

```bash
$ unified-mpc index gc status
gc status: healthy
lease free
quarantine 2 (due 1, in-grace 1)
  due 4d1c0a1f8b25 until 2026-11-03T00:00:00.000Z
  in-grace repo:v1:documented file:v1:9b1c4f2e7a60 until 2026-11-11T00:00:00.000Z
```

- `lease free` — no holder. `lease held by <owner> until <deadline>
  (generation <n>)` adds `expired` once the deadline has passed: an expired
  record is takeable by the next `--apply`, so a status that said "held" would
  claim a fence that would not hold. `lease released by <owner> at <time>`
  describes a retired record, which still keeps the generation monotonic.
- `due` rows have passed their grace deadline and are still in the ledger;
  `in-grace` rows are not candidates yet. A row whose own deadline cannot be
  placed on the timeline — an unparseable `quarantinedAt`, a grace that is not a
  finite number, or a sum outside the range a `Date` can represent — prints
  `until unreadable` and is never counted as due. The expire passes use the same
  rule, so a row this snapshot calls unreadable is retained, not deleted.
- Reachability is not evaluated here. `index gc expire --dry-run` owns that
  verdict, so `due 2` means "two rows would be re-checked", not "two deletions".
- An unreadable ledger throws and exits `1` instead of reporting `due 0`.
- A corrupt lease record prints `lease corrupt` and `gc status: degraded`, and
  exits `1`: the next `--apply` will refuse on it, so this is a real answer
  rather than a transient error.
- Exit `0` for any healthy snapshot, `1` when the lease record is corrupt or a
  store cannot be read, `2` for a usage error.

### `unified-mpc index status [--json]`

Read-only snapshot of the canonical store: the health verdict, every active ref
with its revision, tree and manifest identity, every Goal overlay with its
pinned base and drift state, every unsettled index job with its manifest
liveness, the store counts, and every blocking id. The verdict comes from the
store's own consistency check, so a dangling ref, a Goal overlay whose pinned
base manifest is gone, or a pin whose manifest is missing is reported as
`degraded` rather than guessed at.

```bash
$ unified-mpc index status
canonical store: healthy
refs 1
  refs/remotes/origin/main man:v1:3c9f1e7a5d2b commit 4d1c0a1f8b25 tree 9a2b8c7d6e5f entries 412 pinned rollback
manifests 7
pins 1
overlays 1
  goal goal_01J9ZQ base man:v1:3c9f1e7a5d2b commit 4d1c0a1f8b25 entries modified=2 added=1 deleted=0 base=live updated 2026-11-07T09:30:00.000Z
quarantined 0
active-jobs 1
  op_reindex man:v1:3c9f1e7a5d2b active opened 2026-11-07T09:31:00.000Z manifest=present
dangling-refs 0
missing-overlay-bases 0
orphaned-pins 0
```

- Counts are always printed; the offending ids (`dangling-refs`,
  `missing-overlay-bases`, `orphaned-pins`) are listed under their count only
  when present.
- A ref line keeps revision (`commit`), tree (`tree`) and manifest
  (`manifestId`, `entries`) identity apart, and names the pin reasons retaining
  that manifest. A dangling ref prints `manifest-missing` instead of a guessed
  tree.
- An overlay line identifies the Goal and its pinned base, counts overlay
  entries by kind, and reports `base=live`, `base=drifted` or `base=missing`.
  `drifted` means the base no longer matches the live ref — the same condition
  Goal admission refuses. It is reported, not counted as `degraded`, because
  whether drift must block a long-running Goal is a product decision.
- An index-job line reports whether the manifest the job pins is still stored
  (`manifest=present` or `manifest=missing`).
- Reused versus newly embedded chunks, renamed paths, failures and
  incompatibility/rebuild reasons are provider-owned (§13) and are
  deliberately absent: status never fabricates a semantic counter.
- A quarantine ledger that cannot be read exits `1` with the error instead of
  printing fabricated counts: `quarantined 0` must never stand in for
  "unreadable ledger".
- `quarantined` counts rows waiting for GC, and `active-jobs` counts unsettled
  index jobs — neither is claimed as indexed content.
- Exit `0` only for `healthy`; `1` for `degraded`, after printing the report; `2`
  for arguments that are not `status` plus an optional `--json`.
- `--json` prints the unprojected `CanonicalStatusReport` instead of the
  operator lines.

### `unified-mpc index job list [--json] [--workspace <id>] [--limit <n>]`

Read-only view of Unified's durable Thai-RAG index-job ledger. `index status`
reports canonical store state (refs, overlays, retention); this reports the
builds that actually produced an index: how much was reused from the embedding
cache, how much was newly embedded, which files were skipped and why a job
failed. The record survives provider restarts, so a failure is still readable
after the live provider job is gone.

```bash
$ unified-mpc index job list --limit 2
jobs 42
shown 3
  idx_umcp_14d6e4aacbc64c5d running workspace 9628fc78-f52f-428e-b358-bbfb66037150 owner unified-mpc:3260190 provider idx_d1668d26 reason explicit_request started 2026-11-07T06:29:44.560Z progress 2026-11-07T06:32:43.594Z
    files indexed=120 skipped=4 total=700
    cache hit-files=95 hit-chunks=880 miss-files=25 miss-chunks=190 new-files=25 new-chunks=190
    miss-reasons artifact_missing=25
  idx_umcp_0005cb500f3b41bf failed workspace f4460793-d046-4dcc-b02f-5fadce80283a owner unified-mpc:3260190 reason alias_created_or_repaired started 2026-11-07T03:02:15.640Z finished 2026-11-07T03:02:15.933Z
    error Native Thai-RAG code_index failed: Workspace path /home/alpha/repos/Unified-MPC-Server/.unified-mpc/worktrees/goal-7bfa903721ebe914ef858ee71ad4afcdcb3852d7 is not a directory.
  idx_umcp_7f21ba0d4c9e3311 completed workspace 9628fc78-f52f-428e-b358-bbfb66037150 owner unified-mpc:3260190 reason startup_verification started 2026-11-07T02:40:03.120Z finished 2026-11-07T02:52:47.008Z
    files indexed=0 skipped=700 total=700
```

- `jobs` counts the rows the filter matched. `shown` appears only when the
  bounded listing is shorter than that, so a short history never looks
  truncated. `legacy-unavailable` appears only when rows written before the
  canonical contract exist; they are counted, never attributed to a workspace
  or described with metrics they do not carry.
- Every active row is listed regardless of `--limit`; only terminal history is
  bounded (default `20`, maximum `200`), newest first.
- `--workspace` accepts only the canonical workspace UUID issued by
  registration. A name or path is a usage error rather than a filter that
  silently matches nothing.
- Counters are printed only when the row recorded them: absent is not `0`.
  `running` is the persisted status and `progress` is the last owner-verified
  write, so a stale timestamp is the honest liveness signal. The raw provider
  completion payload is not rendered; `--json` prints the whole
  `ThaiRagIndexJobListing` including `result`.
- The listing never migrates, reaps or rewrites the ledger. A CLI read runs in
  a different process from the runtime owner, so persisting a snapshot there
  could clobber progress the live owner recorded after the read; reaping still
  happens on the runtime's next admission check.
- A failed job is history, not a store failure: exit `0` for any readable
  ledger, `1` when the ledger cannot be read (a corrupt ledger never prints an
  empty history), `2` for usage errors.
- Renamed/deleted path classification and semantic artifact identity remain
  provider-owned (§13). `index revision advance` reports the revision delta;
  this command reports only counters Unified itself recorded.

### `unified-mpc index space [--json]`

Read-only logical counterpart to `storage metrics`: it counts what the canonical
store retains, not how many bytes the SQLite file occupies. Manifests are
classified by the prune planner (retained by a ref, pin, Goal overlay base,
live index job or live provider generation vs prunable) and file artifacts by
the GC reachability planner (reachable vs unreferenced). Nothing is deleted and
no physical fact is claimed.

```bash
$ unified-mpc index space
logical space: measured
manifests total=3 retained=2 prunable=1
artifacts total=4 reachable=3 unreferenced=1
bytes reachable=unmeasured unreferenced=unmeasured
```

- `bytes ... unmeasured` is the honest answer when the store has no measured size
  for every counted artifact; a partial sum would read as a smaller store than it
  is. The numbers never stand in for "the database file shrank" — row deletion
  and revision prune leave the file size to `storage metrics`.
- `refused <reason>` exits `1`: when a reachability root manifest is missing or a
  store cannot be read, a zero-retention count would make every artifact look
  deletable. A corrupt or unreadable artifact or manifest record refuses the
  report as well — skipping it would print a smaller store as if it had been
  measured.
- Artifact counts are content hashes deduped across trust boundaries, which is
  the space the reachability planner consumes; repository-scoped artifact-key
  reachability stays with `index gc`. Chunk (semantic) artifacts are excluded:
  their lifecycle belongs to the Thai-RAG GC boundary, so counting them here
  would report every one of them as unreferenced.
- `--json` prints the unprojected `LogicalSpaceReport` instead of the operator
  lines.
- Exit `0` for `measured`, `1` for `refused` or an unreadable store, `2` for
  arguments that are not `space` plus an optional `--json`.

### `unified-mpc index maintenance (--dry-run | --apply) [--json]`

One bounded, operator-triggered maintenance pass over the canonical store. It
measures the database and the free space on the data filesystem, then runs the
maintenance cycle: headroom pre-flight, the single-owner GC fence, one
resource-admission lease, GC under that same fence, physical SQLite compaction
when the pressure gate admits it, and post-maintenance verification with strict
manifest reads. Nothing schedules itself; this command is the trigger.

```bash
$ unified-mpc index maintenance --dry-run
completed (dry-run) verification healthy manifests 1
compaction planned (pressure-justified)
planned (dry-run) reachable 3 unreachable 1 artifact-unreachable 0
unreachable <sha256>
```

Physical compaction is `VACUUM` followed by `wal_checkpoint(TRUNCATE)`, so the
rebuilt database is copied back out of the WAL and the WAL is reclaimed. The
line reports measured before/after bytes, reclaimed bytes and the freelist
before/after. A reader that blocks the truncate adds
`checkpoint busy (WAL not truncated)`; the pass never claims reclamation it
could not prove, and a later maintenance run retries. A `VACUUM` that reports
the database busy is a successful `compaction skipped (reader-pressure): ...`
verdict, not a failure of the GC pass around it.

- Exactly one of `--dry-run` or `--apply` is required; any other shape exits `2`.
- The pass is pressure-gated. While a reader is active or the checkpoint is
  busy it prints `skipped reader-pressure` (a later run retries); otherwise,
  below the compaction threshold it prints `skipped below-threshold`. Neither
  skip runs GC. `index gc --apply` remains the unconditional GC verb.
- `--dry-run` still takes the fence and the admission decision — the safety
  decision must be the same one an apply takes — but runs GC in plan mode and
  verifies read-only.
- `--apply` quarantines with the default seven-day grace window
  (`DEFAULT_GC_GRACE_MS`); the cycle has no `--grace` flag.
- A refusal prints `refused <reason>: <detail>` and exits `1`. The detail is the
  deciding component's own evidence: required vs free bytes, the fence holder
  and expiry, the admission reason, the GC planner's reason, the compaction
  error (`compaction-failed`), or the degraded dangling-ref/overlay/pin counts.
  If compaction fails and verification is also degraded, the refusal is
  `verify-degraded` and its detail carries both diagnoses. If verification
  itself throws while diagnosing a compaction failure, the refusal stays
  `compaction-failed` and its detail carries the compaction error followed by
  `verification threw: <error>`. The token alone is not the diagnosis.
- `completed` and `skipped` exit `0`.
- `--json` prints the unprojected `MaintenanceCycleReport`, including the
  refusal detail.

---

## 10. Skill Inventory Audit

### `unified-mpc skill audit [--json]`

Read-only inventory of every Skill directory this host can discover, grouped by
the `name` each `SKILL.md` declares. It answers the question the canonical
registry cannot: for one logical Skill name, which directories advertise it,
what full-directory content each one has, and whether the canonical copy holds
the same content as its legacy siblings. Nothing is imported, pruned, deleted
or chosen — a divergent group is reported for human review.

```bash
$ unified-mpc skill audit
skill inventory: 391 directories across 10 roots, 188 declared names
  unique 81 · identical 63 · divergent 43 · unverified 1
canonical 75 matching · 26 diverging · 74 only copy · 12 absent · 0 duplicate · 1 unverified
names needing a decision (44):
  ask-matt  [divergent] canonical matches a legacy copy  variants 4
    <fingerprint>  claude-skills             /home/user/.claude/skills/ask-matt/SKILL.md
    ...
use --json for the full inventory, including identical and unique names
```

- Copies are grouped by the declared `name`, not by directory name, so two
  folders that advertise one Skill are reported as one logical name. The
  canonical identity convention is `skill:<declared name>`.
- `classification` counts distinct full-directory fingerprints: `unique` (one
  copy), `identical` (several copies, one fingerprint), `divergent` (several
  fingerprints), `unverified` (a copy could not be fingerprinted, so no variant
  count is claimed — the operator line prints no `variants` value for it).
- `canonicalState` relates the canonical copy to its legacy siblings:
  `duplicate` (two canonical directories declare one name), `unverified`,
  `absent`, `only-canonical`, `matches`, `diverges`.
- The `canonical` operator line partitions the declared names by
  `canonicalState` — `matching`, `diverging`, `only copy`, `absent`,
  `duplicate`, `unverified` — so the six counts always sum to
  `declaredNames`. `matching` means a legacy copy holds the canonical content;
  a name served only by the canonical root is counted as `only copy`, never as
  matching. `--json` additionally reports `canonicalPresentNames` (every name
  with a canonical copy) and the same buckets in `summary`.
- `--canonical-root <path>` audits a specific canonical tree instead of the
  runtime's own; `--workspace <path>` adds that workspace's workspace-local
  Skill roots to the audit.
- The operator lines list only the names that need a decision; `--json` prints
  the complete `SkillInventoryAuditReport`, including identical and unique
  names.
- Exit `0` normally, `1` when two canonical directories advertise the same
  logical name (`duplicateCanonicalNames > 0`), `2` for argument errors.
  Divergence on its own is the expected state of a host that still keeps its
  legacy roots, so it never fails the command.

---

## 11. Exit Code Contract

The `unified-mpc` CLI adheres to a deterministic exit code contract:
- `0`: Success / normal termination.
- `1`: Operational or runtime failure (e.g., command execution failed, connection refused).
- `2`: Syntax, argument, or validation error (e.g., unknown flag, missing required argument).

Unknown options are rejected, never ignored: `unified-mpc web --no-open` exits `2` with `Unknown option: --no-open` instead of starting the control plane on a default port.

