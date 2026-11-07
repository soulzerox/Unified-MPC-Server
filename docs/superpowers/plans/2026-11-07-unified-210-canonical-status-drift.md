# Unified #210 slice — canonical status drift detail

Issue: soulzerox/Unified-MPC-Server#210 (§11 observability)
Depends on: U26 `canonicalStatus`, U19 `verifyCanonicalStore`, canonical ref /
manifest / pin / overlay / job stores, the `index status` verb (#623) and the
`index revision list` verb (#625).
Status: plan-first, red-first implementation in this slice.

## Why this slice now

The two existing canonical read models answer different halves of §7:

- `index revision list` answers *what revisions exist and what still holds
  each of them*;
- `index status` answers *what is active and is the store consistent*.

Neither exposes §11's per-pointer identity or stale state. The active ref row
drops the tree oid, manifest creation time and entry count. An overlay is only
a count, so an operator cannot tell which Goal is pinned to which base, whether
the base still matches the live ref, or how much the overlay changes. Unsettled
index jobs are only a count, so a job whose manifest has disappeared is
invisible.

That last distinction already exists in code: `verifyGoalAdmission` fails closed
when a Goal overlay's base commit/tree/manifest no longer equals the live ref.
`index status` cannot show the same condition, so a resume refusal is the first
place an operator learns about it. This slice projects the condition without
changing any verdict.

## What lands

### 1. Enriched read model in `canonicalStatus`

`CanonicalStatusReport` keeps every existing field and gains three detail lists.

`refs[]` keeps `ref`, `manifestId`, `commitSha` and adds:

- `treeOid`, `manifestCreatedAt`, `manifestEntryCount` — the exact revision /
  tree / manifest identity §11 asks status to distinguish;
- `manifestExists` — false for the same dangling ref the verdict already names;
- `pinned`, `pinReasons` — whether the active manifest is retained by a pin and
  why, so a ref row cannot hide a retention blocker.

`overlays[]` (new) carries one row per stored Goal overlay:

- `goalWorkspaceId`, `baseManifestId`, `baseCommitSha`, `baseTreeOid` — overlay
  identity and its pinned base;
- `baseManifestExists` — false for the missing overlay base the verdict names;
- `baseMatchesLiveRef` — the exact commit/tree/manifest equality used by
  `verifyGoalAdmission`; false means the base has drifted from the live ref;
- `modifiedCount`, `addedCount`, `deletedCount` — overlay size by entry kind;
- `updatedAt`.

`jobs[]` (new) carries one row per unsettled index job:

- `operationId`, `manifestId`, `status`, `openedAt`, `updatedAt`;
- `manifestExists` — whether the manifest the job pins is still stored.

All existing counts and blocker arrays stay unchanged, and the health verdict
stays `verifyCanonicalStore`'s. A drifted overlay base is reported, never
counted as degraded: whether drift must block a long-running Goal is still an
open product decision, and this projection must not pre-empt it.

### 2. CLI rendering

`unified-mpc index status` keeps the count lines and extends the detail lines:

- ref: `<ref> <manifestId> commit <sha> tree <tree> entries <n> pinned|unpinned`,
  or `manifest-missing` when the manifest row is gone;
- overlay: `  goal <id> base <manifestId> commit <sha> entries modified=<n>
  added=<n> deleted=<n> base=<live|drifted|missing>`;
- job: `  <operationId> <manifestId> <status> opened <iso>
  manifest=<present|missing>`.

Provider-owned counters are deliberately absent: reused files/chunks, newly
embedded chunks, renamed paths, failures and incompatibility/rebuild reasons
belong to the thai-rag-mcp §13 contract. Status must not fabricate them.

### 3. Docs and guard

`docs/CLI_REFERENCE.md` §9 gains the enriched output block and the
report-not-block rule for a drifted base. Formatter and projection tests pin the
new shape; the existing command-line docs guard still covers dispatch.

## Explicit non-goals

- No change to `verifyCanonicalStore` semantics or the health verdict.
- No blocking, refusing or auto-repair on a drifted overlay base.
- No provider job metrics or failure reasons (§13).
- No WebUI projection; the CLI remains the admin status surface.
- No new MCP tool, persistence or write path.

## Verification

1. Projection unit tests: empty store; ref identity and pin reasons; overlay
   live / drifted / missing base with entry counts; job with present and missing
   manifest.
2. CLI formatter tests: enriched ref line, overlay and job detail, unchanged
   blocker sections and exit codes.
3. `verify:targeted` during iteration, then `verify:local` on the exact head;
   exact-head review; guarded merge.
