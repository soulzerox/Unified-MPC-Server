#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
VALIDATOR="$SCRIPT_DIR/validate-runtime-root.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$TMP_ROOT"' EXIT

pass_count=0

make_runtime() {
  local root="$1"
  mkdir -p "$root/apps/cli/dist/bin"
  printf 'export {};\n' >"$root/apps/cli/dist/bin/mcp-http.js"
  printf 'export {};\n' >"$root/apps/cli/dist/index.js"
  printf '{}\n' >"$root/apps/cli/dist/build-provenance.json"
}

expect_ok() {
  local service="$1"
  local root="$2"
  local output
  output="$(bash "$VALIDATOR" "$service" "$root" 2>&1)"
  grep -Fq 'RUNTIME_ROOT_OK:' <<<"$output"
  pass_count=$((pass_count + 1))
}

expect_fail() {
  local expected_status="$1"
  local expected_code="$2"
  local service="$3"
  local root="$4"
  local output status
  set +e
  output="$(bash "$VALIDATOR" "$service" "$root" 2>&1)"
  status=$?
  set -e
  if [[ "$status" -ne "$expected_status" ]]; then
    printf 'expected status %s, got %s: %s\n' "$expected_status" "$status" "$output" >&2
    exit 1
  fi
  grep -Fq "$expected_code" <<<"$output"
  pass_count=$((pass_count + 1))
}

canonical="$TMP_ROOT/canonical"
make_runtime "$canonical"
expect_ok mcp-http "$canonical"
expect_ok web "$canonical"

release="$TMP_ROOT/releases/20260921-d86a603"
make_runtime "$release"
expect_ok mcp-http "$release"

expect_fail 64 RUNTIME_ROOT_INVALID mcp-http "relative/runtime"
expect_fail 66 RUNTIME_ROOT_INVALID mcp-http "$TMP_ROOT/missing"

missing_entry="$TMP_ROOT/missing-entry"
make_runtime "$missing_entry"
rm "$missing_entry/apps/cli/dist/bin/mcp-http.js"
expect_fail 67 RUNTIME_ARTIFACT_MISSING mcp-http "$missing_entry"

missing_provenance="$TMP_ROOT/missing-provenance"
make_runtime "$missing_provenance"
rm "$missing_provenance/apps/cli/dist/build-provenance.json"
expect_fail 67 RUNTIME_ARTIFACT_MISSING web "$missing_provenance"

direct_worktree="$TMP_ROOT/repo/.unified-mpc/worktrees/goal-104"
make_runtime "$direct_worktree"
expect_fail 65 RUNTIME_ROOT_DISPOSABLE mcp-http "$direct_worktree"

legacy_worktree="$TMP_ROOT/repo/.worktrees/issue-104"
make_runtime "$legacy_worktree"
expect_fail 65 RUNTIME_ROOT_DISPOSABLE web "$legacy_worktree"

goal_workspace="$TMP_ROOT/state/goal-workspaces/goal-104"
make_runtime "$goal_workspace"
expect_fail 65 RUNTIME_ROOT_DISPOSABLE mcp-http "$goal_workspace"

symlink_target="$TMP_ROOT/repo/.unified-mpc/worktrees/symlink-target"
make_runtime "$symlink_target"
ln -s "$symlink_target" "$TMP_ROOT/current"
expect_fail 65 RUNTIME_ROOT_DISPOSABLE mcp-http "$TMP_ROOT/current"

linked_worktree="$TMP_ROOT/external-linked-worktree"
make_runtime "$linked_worktree"
printf 'gitdir: %s\n' "$TMP_ROOT/repo/.git/worktrees/external-linked-worktree" >"$linked_worktree/.git"
expect_fail 65 RUNTIME_ROOT_DISPOSABLE web "$linked_worktree"

# #835: a release whose entrypoint imports a sibling it does not contain passes
# the entrypoint/provenance checks and then dies on the next restart with
# ERR_MODULE_NOT_FOUND, so the closure is checked before promotion. Every import
# form the build can emit is pinned, so narrowing the scan cannot go unnoticed.
closure_ok="$TMP_ROOT/closure-ok"
make_runtime "$closure_ok"
printf "export * from './present.js';\n" >"$closure_ok/apps/cli/dist/index.js"
printf 'export const present = 1;\n' >"$closure_ok/apps/cli/dist/present.js"
printf "export * from './present.js';\n" >"$closure_ok/apps/cli/dist/bin/mcp-http.js"
printf 'export const present = 1;\n' >"$closure_ok/apps/cli/dist/bin/present.js"
expect_ok web "$closure_ok"
expect_ok mcp-http "$closure_ok"

closure_entry_case() {
  local name="$1"
  local body="$2"
  local root="$TMP_ROOT/closure-$name"
  make_runtime "$root"
  printf '%s\n' "$body" >"$root/apps/cli/dist/index.js"
  expect_fail 67 RUNTIME_ARTIFACT_INCOMPLETE web "$root"
}

closure_entry_case export-star "export * from './gone.js';"
closure_entry_case export-named "export { present } from './gone.js';"
closure_entry_case import-default "import present from './gone.js';"
closure_entry_case import-namespace "import * as present from './gone.js';"
closure_entry_case import-named "import { present } from './gone.js';"
closure_entry_case import-side-effect "import './gone.js';"
closure_entry_case import-dynamic "const present = await import('./gone.js');"
closure_entry_case require-call "const present = require('./gone.js');"
closure_entry_case import-multiline $'import {\n  present\n} from \'./gone.js\';'

# The credential helper is shipped and exec'd by the launcher, so its closure is
# checked too rather than only its presence.
closure_helper="$TMP_ROOT/closure-helper"
make_runtime "$closure_helper"
printf "export * from './present.js';\n" >"$closure_helper/apps/cli/dist/index.js"
printf 'export const present = 1;\n' >"$closure_helper/apps/cli/dist/present.js"
printf "export * from './helper.js';\n" >"$closure_helper/apps/cli/dist/bin/publish-credential-helper.js"
expect_fail 67 RUNTIME_ARTIFACT_INCOMPLETE mcp-http "$closure_helper"
printf 'export const helper = 1;\n' >"$closure_helper/apps/cli/dist/bin/helper.js"
expect_ok mcp-http "$closure_helper"

# The outage class the live service actually hit: the release carries a pnpm
# store copy of a workspace package, and that copy's own module imports a file
# the copy does not contain. Relative-only closure walking cannot see it, so a
# bare workspace specifier must resolve through node_modules into the closure.
make_workspace_fixture() {
  local root="$1"
  make_runtime "$root"
  mkdir -p "$root/apps/cli/node_modules/@unified-mpc/mcp-server/dist"
  printf '{"name":"@unified-mpc/mcp-server","type":"module","exports":{".":{"import":{"development":"./src/index.ts","default":"./dist/index.js"}}}}\n' \
    >"$root/apps/cli/node_modules/@unified-mpc/mcp-server/package.json"
  printf "export * from './tool-registry.js';\n" >"$root/apps/cli/node_modules/@unified-mpc/mcp-server/dist/index.js"
  printf "import './mutation-subject.js';\n" >"$root/apps/cli/node_modules/@unified-mpc/mcp-server/dist/tool-registry.js"
  printf "export * from '@unified-mpc/mcp-server';\n" >"$root/apps/cli/dist/index.js"
  printf "export * from '@unified-mpc/mcp-server';\n" >"$root/apps/cli/dist/bin/mcp-http.js"
}

closure_workspace="$TMP_ROOT/closure-workspace"
make_workspace_fixture "$closure_workspace"
expect_fail 67 RUNTIME_ARTIFACT_INCOMPLETE mcp-http "$closure_workspace"
printf 'export const subject = 1;\n' >"$closure_workspace/apps/cli/node_modules/@unified-mpc/mcp-server/dist/mutation-subject.js"
expect_ok mcp-http "$closure_workspace"

closure_workspace_absent="$TMP_ROOT/closure-workspace-absent"
make_runtime "$closure_workspace_absent"
printf "export * from '@unified-mpc/mcp-server';\n" >"$closure_workspace_absent/apps/cli/dist/bin/mcp-http.js"
expect_fail 67 RUNTIME_ARTIFACT_INCOMPLETE mcp-http "$closure_workspace_absent"

# Package links point into a pnpm store, so the walk has to start from the
# realpath. A store copy resolves its own workspace siblings from the store
# node_modules, never from the link site, so a link-site walk reports packages
# the release does carry as missing.
closure_workspace_store="$TMP_ROOT/closure-workspace-store"
make_workspace_fixture "$closure_workspace_store"
store_package="$closure_workspace_store/apps/cli/node_modules/.pnpm/@unified-mpc+mcp-server@file+packages+mcp-server/node_modules/@unified-mpc/mcp-server"
mkdir -p "$(dirname "$store_package")"
mv "$closure_workspace_store/apps/cli/node_modules/@unified-mpc/mcp-server" "$store_package"
ln -s "../.pnpm/@unified-mpc+mcp-server@file+packages+mcp-server/node_modules/@unified-mpc/mcp-server" \
  "$closure_workspace_store/apps/cli/node_modules/@unified-mpc/mcp-server"
printf 'export const subject = 1;\n' >"$store_package/dist/mutation-subject.js"
mkdir -p "$store_package/../nested/dist"
printf '{"name":"@unified-mpc/nested","type":"module","exports":{".":"./dist/index.js"}}\n' \
  >"$store_package/../nested/package.json"
printf 'export const nested = 1;\n' >"$store_package/../nested/dist/index.js"
printf "export * from '@unified-mpc/nested';\n" >>"$store_package/dist/index.js"
expect_ok mcp-http "$closure_workspace_store"
rm "$store_package/dist/mutation-subject.js"
expect_fail 67 RUNTIME_ARTIFACT_INCOMPLETE mcp-http "$closure_workspace_store"

# A workspace subpath resolves through its exports map, whose target is not the
# literal specifier path (@unified-mpc/shared/date-time-display), so a release
# carrying the exported file must not be refused for a missing literal path.
closure_workspace_subpath="$TMP_ROOT/closure-workspace-subpath"
make_workspace_fixture "$closure_workspace_subpath"
printf 'export const subject = 1;\n' \
  >"$closure_workspace_subpath/apps/cli/node_modules/@unified-mpc/mcp-server/dist/mutation-subject.js"
shared_package="$closure_workspace_subpath/apps/cli/node_modules/@unified-mpc/shared"
mkdir -p "$shared_package/dist"
printf '{"name":"@unified-mpc/shared","type":"module","exports":{".":"./dist/index.js","./date-time-display":"./dist/date-time-display.js"}}\n' \
  >"$shared_package/package.json"
printf 'export const display = 1;\n' >"$shared_package/dist/index.js"
printf 'export const display = 1;\n' >"$shared_package/dist/date-time-display.js"
printf "export * from '@unified-mpc/shared/date-time-display';\n" \
  >>"$closure_workspace_subpath/apps/cli/node_modules/@unified-mpc/mcp-server/dist/tool-registry.js"
expect_ok mcp-http "$closure_workspace_subpath"
rm "$shared_package/dist/date-time-display.js"
expect_fail 67 RUNTIME_ARTIFACT_INCOMPLETE mcp-http "$closure_workspace_subpath"

# A package exported by a symlink out of the release is not in the release. The
# materialized tree keeps such a link into the source checkout until after this
# check, so following it would pass a release the service could not boot.
closure_workspace_escape="$TMP_ROOT/closure-workspace-escape"
make_workspace_fixture "$closure_workspace_escape"
rm -rf "$closure_workspace_escape/apps/cli/node_modules/@unified-mpc/mcp-server"
escape_target="$TMP_ROOT/outside-tree/thing"
mkdir -p "$escape_target/dist"
printf '{"name":"@unified-mpc/mcp-server","type":"module","exports":{".":"./dist/index.js"}}\n' \
  >"$escape_target/package.json"
printf 'export const thing = 1;\n' >"$escape_target/dist/index.js"
ln -s "$escape_target" "$closure_workspace_escape/apps/cli/node_modules/@unified-mpc/mcp-server"
expect_fail 67 RUNTIME_ARTIFACT_INCOMPLETE mcp-http "$closure_workspace_escape"

# A package that declares exports refuses an undeclared subpath, so the release
# must not be judged by a literal file the loader would never resolve. The
# literal file exists on purpose: a file fallback would accept it.
closure_workspace_undeclared="$TMP_ROOT/closure-workspace-undeclared"
make_workspace_fixture "$closure_workspace_undeclared"
printf 'export const subject = 1;\n' \
  >"$closure_workspace_undeclared/apps/cli/node_modules/@unified-mpc/mcp-server/dist/mutation-subject.js"
printf 'export const undeclared = 1;\n' \
  >"$closure_workspace_undeclared/apps/cli/node_modules/@unified-mpc/mcp-server/undeclared.js"
printf "export * from '@unified-mpc/mcp-server/undeclared';\n" \
  >>"$closure_workspace_undeclared/apps/cli/node_modules/@unified-mpc/mcp-server/dist/tool-registry.js"
expect_fail 67 RUNTIME_ARTIFACT_INCOMPLETE mcp-http "$closure_workspace_undeclared"

# A node that cannot run the scan is a preflight failure, not an artifact verdict.
set +e
UNIFIED_MPC_NODE=/bin/false bash "$VALIDATOR" web "$closure_ok" >/dev/null 2>&1
unusable_node_status=$?
set -e
if [[ "$unusable_node_status" -ne 69 ]]; then
  printf 'expected status 69 for an unusable node, got %s\n' "$unusable_node_status" >&2
  exit 1
fi
pass_count=$((pass_count + 1))

# A closure member that exists but cannot be read is a preflight failure too, not
# a complete release: only ENOENT means "the release does not carry the file".
closure_unreadable="$TMP_ROOT/closure-unreadable"
make_runtime "$closure_unreadable"
printf "export * from './dir.js';\n" >"$closure_unreadable/apps/cli/dist/index.js"
mkdir "$closure_unreadable/apps/cli/dist/dir.js"
expect_fail 69 RUNTIME_ROOT_INVALID web "$closure_unreadable"

# The stdio entry is shipped and executed by client configs, and its closure
# reaches files no other entry does.
closure_stdio="$TMP_ROOT/closure-stdio"
make_runtime "$closure_stdio"
printf "export * from './present.js';\n" >"$closure_stdio/apps/cli/dist/index.js"
printf 'export const present = 1;\n' >"$closure_stdio/apps/cli/dist/present.js"
printf "export * from './stdio-missing.js';\n" >"$closure_stdio/apps/cli/dist/bin/mcp-stdio.js"
expect_fail 67 RUNTIME_ARTIFACT_INCOMPLETE web "$closure_stdio"

expect_fail 64 RUNTIME_ROOT_INVALID unknown-service "$canonical"

printf 'runtime-root preflight: %s checks passed\n' "$pass_count"
