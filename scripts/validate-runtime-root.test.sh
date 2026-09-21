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

expect_fail 64 RUNTIME_ROOT_INVALID unknown-service "$canonical"

printf 'runtime-root preflight: %s checks passed\n' "$pass_count"
