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
