# Repository agent instructions

## Automatic scheduled continuation

When a user-authorized repository task is still incomplete and the user has authorized scheduled continuation, load and follow [`.agents/skills/unified-mpc-scheduled-continuation/SKILL.md`](.agents/skills/unified-mpc-scheduled-continuation/SKILL.md) as the source of truth. Never create a schedule when the user has explicitly opted out for the current task.

For rolling continuation, the workspace skill is authoritative. Current mainline uses exactly one **hourly recurring** Native ChatGPT Scheduled Task for an active goal, in the current chat with cloud execution requested. Ordinary checkpoints and ordinary recurring wakes reuse the same native task; they do not create or retime a per-turn successor. Historical one-time watchdog rows are compatibility-only. Never use legacy schedulers, cron, shell timers, browser/DOM automation, or undocumented scheduler APIs as a fallback. Never create or re-enable scheduled continuation when the user has explicitly disabled it for the current task.

Every rolling-mode workspace mutation must use the current `goalLease` token/generation proof. Same MCP session identity is not ownership proof. Track background work with goal-relative `trackedTasks`: `blocking_job` entries participate in liveness, while `supporting_service` entries do not; explicit `provider` routing and `cancelWithGoal` ownership prevent a shared service from being probed or stopped accidentally. Legacy `activeTaskIds` rows decode conservatively as goal-owned blocking jobs. Live or unknown liveness fails closed; stale-owner takeover must follow the bounded recovery rules in the scheduled-continuation skill. A request to disable scheduling stops only scheduled continuation and never abandons the durable goal. When the goal finishes, make the exact Native ChatGPT task non-runnable using the strongest operation actually exposed by the host (prefer true delete, otherwise host-confirmed disable), record truthful cleanup evidence, finish the goal, verify `get_goal` is terminal, and stop. Never report completion while the goal is active.

## Local-only verification before every PR

This repository has no GitHub Actions verification. Build, test, lint and
typecheck run locally, and local evidence is what authorizes a merge.

Run the merge-readiness profile on the **exact commit** you are about to push:

```sh
corepack pnpm@10.15.0 verify:local
```

It runs `diff-check`, `typecheck`, `lint`, `build`, the `workspace`, `storage`,
`mcp-server` and `cli` suites, then version consistency, the tool catalog check
and `dist` provenance freshness. It refuses a dirty worktree because provenance
and the build-provenance test describe the committed tree, and it writes a
durable receipt to `.unified-mpc/local-verify/` (`headSha`, `diffFingerprint`,
per-step exit codes, bounded log refs, `mergeReady`).

For fast iteration before committing, use the subset:

```sh
corepack pnpm@10.15.0 verify:targeted
```

Copy the `mergeReady` verdict and the failing step names into the PR body. Never
claim local CI passed without a receipt for the current head. The unit tests for
the profile runner are `node --test scripts/local-verify.test.mjs`.

## Authoritative CI Watcher Policy

When a GitHub Actions workflow must be monitored until completion, use one authoritative long-running background/durable watcher for the exact workflow run instead of repeated ad-hoc polling.

- Resolve and record the exact GitHub Actions run ID first. Never monitor only "the latest run on a branch" after the watcher starts.
- Before starting a watcher, inspect existing authoritative shell/process tasks. If a live watcher already targets the same exact run ID, reuse its task ID and inspect/wait/result it; do not start a duplicate watcher.
- Preferred watcher command: `gh run watch <RUN_ID> -i 20 --exit-status`.
- Treat the watcher task as the authoritative task for that CI run and keep it attached to the durable goal as a `blocking_job` when goal tracking is active.
- Do not report CI success until the authoritative watcher is terminal and the GitHub workflow conclusion is confirmed.
- On failure, inspect the actual GitHub Actions job logs for that exact run before changing code. Do not guess from branch state or from a different run.
- Never merge, tag, publish, or release from a SHA whose required CI run failed or is still non-terminal.
- Multiple exact workflow run IDs may be chained inside one durable watcher process when appropriate, but preserve each workflow's exit code and fail the watcher if any required workflow fails.
- A CI watcher is process monitoring, not a ChatGPT Scheduled Task. Do not create or re-enable scheduled continuation merely to watch CI when the user has scheduling disabled.
- Linux POSIX native execution:

  ```sh
  gh run watch 123456 -i 20 --exit-status
  ```

This policy is platform-native for Linux Ubuntu environments.

## Pull request closure safety

GitHub parses closing keywords even when the surrounding prose retracts them. Before creating or updating a PR body, run the check against the exact title and body:

```sh
gh pr view <number> --json title,body | node scripts/check-issue-closing-keywords.mjs -
# before the PR exists
node scripts/check-issue-closing-keywords.mjs --title "<title>" --body-file /tmp/pr-body.md
```

Never write `Closes/Fixes/Resolves #N` for an issue that must stay open, not even as a rhetorical question such as `Closes #145? No`. Use `Refs #N`, `Parent #N remains open`, or `Partial scope for #N` instead.

`Full Bypass` is an explicit runtime exception to application approval and scope enforcement: while a Full profile has the relevant Desktop or STDIO Full Bypass toggle enabled, permission prompts, Active Project scope, and other unified-mpc approval gates may be skipped. Durable-goal ownership is different: if a workspace has a live rolling scheduled-goal mutation fence, `ToolRegistry` must still require and validate the current `goalLease` before mutation, even under Full Bypass. This prevents a stale worker from mutating after handoff. Ordinary unscheduled Full Bypass calls remain lease-free when no live rolling-goal fence exists.
