# Unified #210 slice — Goal admission canonical base pin

Issue: soulzerox/Unified-MPC-Server#210 (§4 Goal Workspace admission gate,
§5 dirty Goal base + overlay, §7 retain active Goal bases)
Status: plan-first, red-first implementation in this slice.

## Why this slice now

The canonical store is produced in production again: #639 advances the
canonical ref after a reconciled merge. The Goal half is still library-only.

`attachGoalBasePin`, `verifyGoalAdmission` and `resolveGoalLogicalView` exist
and are tested in `packages/workspace`, but nothing outside tests calls them:

~~~text
GoalWorkspaceService.create
  -> resolves exact base commit
  -> creates the Git worktree
  -> registers the workspace
  -> ???  (no canonical base pin, no overlay)
~~~

So a real Goal worktree never pins a base revision, and §4's "attach the shared
base manifest, start with an empty overlay" has never run outside a unit test.

## What lands

### 1. `pinGoalBaseAtCommit` in `packages/workspace/src/goal-admission.ts`

A narrow admission policy over the existing stores:

- read the canonical ref **strictly** (a corrupt ref is reported, never read as
  "never promoted");
- no ref, or a ref at another commit, is an explicit `skipped` outcome with a
  reason — a repository that has never advanced must keep admitting Goals;
- when the live ref is the requested commit, attach the overlay through
  `attachGoalBasePin`, so the overlay can only exist against a ref that was
  just read;
- write failures are returned as `failed`, never thrown into the caller that
  already created the worktree.

### 2. `GoalWorkspaceService` reports the outcome

- optional `canonicalAdmission` port in `GoalWorkspaceServiceOptions`;
- after successful registration, `create` calls the port with the registered
  workspace id and the exact resolved base commit;
- `GoalWorkspaceCreateResult.canonicalAdmission` carries the outcome
  (additive; omitted when the runtime has no port);
- a pin failure never rolls back or fails Goal creation: the worktree and
  registration are already durable, and the outcome is reported so the runtime
  can log it. Snapshot Goals have no commit and are unchanged.

### 3. Runtime wiring

`apps/cli/src/runtime/stdio-mcp-runtime.ts` constructs the port from
`<dataPath>/canonical` (`CanonicalRefStore` + `GoalOverlayStore`) with
`refs/remotes/origin/main`, and logs a failed pin to stderr. A skip is normal
(no canonical ref yet, or an explicit historical/feature base) and is not
logged per admission.

## Explicit non-goals

- No on-demand manifest construction at admission. A base that is not the live
  canonical ref is skipped, not hashed and advanced implicitly.
- No fail-closed Goal creation. A missing canonical ref must not break Goals in
  repositories that have no merge policy or have never advanced.
- No drift verification in `status`/`resume`; that is the next slice once
  admission pins exist.
- No overlay population from the worktree, no pre-edit/search consumer, no
  semantic materialization (Thai-RAG-owned).
- Snapshot Goal Workspaces unchanged.

## Verification

1. Red-first `goal-admission` tests: pinned / no ref / moved ref / corrupt ref /
   write failure.
2. Red-first `GoalWorkspaceService.create` tests: port receives the registered
   id and resolved base; a failed pin still returns the created workspace;
   no port keeps the current result shape.
3. Targeted `@unified-mpc/workspace` and `@unified-mpc/application` suites.
4. Full `verify:local` on the exact head before the review capsule.
