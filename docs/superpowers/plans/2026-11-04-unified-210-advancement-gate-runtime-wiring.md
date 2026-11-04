# Unified #210 slice — advancement-gate runtime wiring (operator path)

Issue: soulzerox/Unified-MPC-Server#210 (§2 current-file invariant, §3 Canonical
Revision Advancement Gate, §6 one canonical store, §7 admin capabilities, §11
full indexing becomes exceptional)
Depends on: #412 (advance orchestration `advanceCanonicalRevision`), #398
(`registerManifestArtifacts`), canonical stores U7/U15, artifact store U6.
Status: plan-first, red-first implementation in this slice.

## Why this slice now

The canonical chain is complete as a library and **inert in production**:

~~~text
Git ref/commit/tree  --???-->  manifest  --???-->  ref promotion  --???-->  artifacts
                                    ^                                        ^
                        advanceCanonicalRevision                  registerManifestArtifacts
                        (tests only)                             (tests only)
~~~

`grep -rn advanceCanonicalRevision --include=*.ts` outside tests and
`.typecheck` returns its own definition and nothing else. Consequences today:

- `refs.read(...)` is never written by a running process, so every GC pass
  (`gc-cycle`, `artifact-gc-roots`, `artifact-key-gc`) sees an empty candidate
  set and no artifact is ever a reuse candidate;
- `#210 §3`'s promotion sequence has never run against a real Git tree, so the
  "3 of 695 changed files must not rebuild" guarantee has never been observed
  end to end;
- the §7 admin surface (`index_revision_*`) does not exist in the CLI, so there
  is no operator way to establish or inspect the canonical pointer at all.

The missing piece is a **producer**: something that reads the resulting Git tree
of an exact commit, turns it into `path -> sha256(content)` entries, and drives
the existing gate. Everything downstream already exists.

## What lands

### 1. `packages/workspace/src/git-revision-advance.ts` (new, deep module)

`advanceRevisionFromGit({ root, source, targetRef, now, repositoryId? })`

- `CanonicalGitSource` is the port: `resolveRevision(ref)`, `listTree(commit)`,
  `hashBlobs(oIds)`, `remoteUrl()`. The package keeps its current dependency
  set (`domain` + `shared`); no Git adapter is imported here, so tests drive a
  fake source and the real one lives in the CLI.
- Identity: `revisionId = canonicalRevisionId(...)` from the *Git* tree OID,
  parents and target ref (§2: commit/tree are revision identity, never the
  artifact key); `repositoryId` defaults to `repo:v1:<sha256(remoteUrl)>` and can
  be pinned explicitly. A changed remote is a new trust boundary, never silent
  cross-boundary sharing.
- **The resulting Git tree is truth.** Entries come from `ls-tree -r` of the
  exact commit plus byte-exact SHA-256 of each blob, never from the worktree,
  the index, or a diff. That is the only condition under which `targetVerified`
  may be `true`, and it is what the module passes to the gate.
- Fail-closed refusals before anything is written: unresolvable ref; a tree
  entry that is not a blob (submodule gitlink / nested tree) — §8 semantics for
  those are not decided yet, so they are refused, not silently skipped; no
  repository identity.
- Promotion order: base manifest is read first, delta classified, manifest
  persisted, then `refs.promote` CAS with the state read before the hashing
  pass. A concurrent advance therefore conflicts instead of clobbering.
- Artifacts: after a `promoted`/`noop` promotion the module calls
  `registerManifestArtifacts` for the new manifest with a source classification
  policy (`language` from a fixed extension table, `sourceKind: 'source'`,
  `representationVersion: 'v1'`). Unknown extensions stay unclassified and are
  reported — §11 forbids claiming an unindexed file was indexed. A registration
  refusal is reported, not thrown, and leaves the (authoritative) ref intact;
  artifacts are re-derivable metadata. The CLI surfaces it as a non-zero exit.

### 2. `apps/cli/src/runtime/canonical-git-source.ts` (new, real adapter)

`spawn`-based `CanonicalGitSource` over one repository root:

- `git rev-parse --verify <ref>^{commit}`, `<commit>^{tree}`,
  `git rev-list --parents -n 1 <commit>`, `git ls-tree -r -z --full-tree`;
- `git cat-file --batch` with a size-framed streaming reader that hashes each
  blob's exact bytes as it arrives, so one process serves the whole tree and no
  blob is buffered whole or decoded as text;
- binary-safe: a non-UTF-8 blob is hashed as bytes.

### 3. CLI `index revision advance [--ref <ref>] [--repository-id <id>] [--json]`

The §7 admin surface's first verb, wired through `createDefaultCliDependencies`
with the durable root at `<dataPath>/canonical`. Default ref
`refs/remotes/origin/main`. The command never fetches: recording an advance to a
commit the ref does not point at would make the manifest lie, so the operator
fetches first and the command reports what the ref actually resolves to.

Report lines name the evidence: exact commit, Git tree OID, manifest id, delta
counts (reused / new / renamed / deleted) and artifact counts (reused /
registered / unclassified). `--json` prints one document.

## Explicit non-goals

- No automatic post-merge invocation. This slice makes promotion *possible and
  observable* from an operator command; deciding where the automatic advance
  hangs (guarded-merge tail vs. a reconciliation poller) needs its own slice,
  and the module above is the seam both can call.
- No Goal-workspace base pin, overlay, GC scheduling, quarantine or revision
  pruning. Those modules exist and are untouched.
- No semantic/chunk artifacts, no payload bytes, no embeddings: Thai-RAG-owned
  (#210 §13).
- No fetch, no network, no remote Git access.

## Verification

1. Unit: fake source, temp root — promotion, noop, conflict, unresolved ref,
   non-blob refusal, missing remote refusal, rename-same-content reuse, and the
   reused-vs-new artifact split.
2. Real Git: a temporary repository driven through the real adapter proves the
   `--batch` framer and the `ls-tree` parse against actual Git output, including
   a non-UTF-8 blob and a rename.
3. CLI: parse, dispatch, exit codes and both output forms; the docs guard
   replays the documented example against a stubbed dependency.
