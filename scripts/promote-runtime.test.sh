#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROMOTER="$SCRIPT_DIR/promote-runtime.sh"
VALIDATOR="$SCRIPT_DIR/validate-runtime-root.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$TMP_ROOT"' EXIT

export HOME="$TMP_ROOT/home"
export XDG_DATA_HOME="$TMP_ROOT/data"
export XDG_STATE_HOME="$TMP_ROOT/state"
export UNIFIED_MPC_RUNTIME_DIR="$XDG_DATA_HOME/unified-mpc/runtime"
export UNIFIED_MPC_DEPLOY_STATE_DIR="$XDG_STATE_HOME/unified-mpc/deployments"
export UNIFIED_MPC_VALIDATE_RUNTIME_ROOT="$VALIDATOR"
export UNIFIED_MPC_SYSTEMD_SERVICE="unified-mpc.service"
export UNIFIED_MPC_TEST_SYSTEMCTL_LOG="$TMP_ROOT/systemctl.log"

mkdir -p "$HOME" "$UNIFIED_MPC_RUNTIME_DIR/releases" "$TMP_ROOT/bin"

cat >"$TMP_ROOT/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$UNIFIED_MPC_TEST_SYSTEMCTL_LOG"
exit 0
EOF

cat >"$TMP_ROOT/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
active="$(readlink -f -- "$UNIFIED_MPC_RUNTIME_DIR/current" 2>/dev/null || true)"
[[ -n "$active" && -d "$active" ]] || exit 7
[[ ! -f "$active/health.fail" ]] || exit 22
cat "$active/apps/cli/dist/build-provenance.json"
EOF

chmod +x "$TMP_ROOT/bin/systemctl" "$TMP_ROOT/bin/curl"
export UNIFIED_MPC_SYSTEMCTL="$TMP_ROOT/bin/systemctl"
export UNIFIED_MPC_CURL="$TMP_ROOT/bin/curl"

make_runtime() {
  local root="$1"
  local commit="$2"
  local dirty="${3:-false}"
  mkdir -p "$root/apps/cli/dist/bin"
  printf 'export {};\n' >"$root/apps/cli/dist/bin/mcp-http.js"
  printf 'export {};\n' >"$root/apps/cli/dist/index.js"
  local suffix=""
  if [[ "$dirty" == "true" ]]; then
    suffix=".dirty"
  fi
  cat >"$root/apps/cli/dist/build-provenance.json" <<EOF
{
  "version": "4.61.0",
  "buildVersion": "4.61.0+${commit:0:12}$suffix",
  "buildCommit": "$commit",
  "buildShortCommit": "${commit:0:12}",
  "buildTime": "2026-09-22T00:00:00.000Z",
  "buildDirty": $dirty
}
EOF
}

assert_link() {
  local link="$1"
  local expected="$2"
  local actual
  actual="$(readlink -f -- "$link")"
  [[ "$actual" == "$expected" ]] || {
    printf 'expected %s -> %s, got %s\n' "$link" "$expected" "$actual" >&2
    exit 1
  }
}

expect_fail() {
  local expected_code="$1"
  shift
  local output status
  set +e
  output="$("$@" 2>&1)"
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || {
    printf 'expected failure, got success: %s\n' "$output" >&2
    exit 1
  }
  grep -Fq "$expected_code" <<<"$output" || {
    printf 'expected diagnostic %s, got: %s\n' "$expected_code" "$output" >&2
    exit 1
  }
}

commit_a="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
commit_b="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
commit_c="cccccccccccccccccccccccccccccccccccccccc"
commit_d="dddddddddddddddddddddddddddddddddddddddd"
commit_e="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"

release_a="$UNIFIED_MPC_RUNTIME_DIR/releases/deploy-a"
make_runtime "$release_a" "$commit_a"
bash "$PROMOTER" "$release_a" "deploy-a" >/dev/null
assert_link "$UNIFIED_MPC_RUNTIME_DIR/current" "$release_a"
assert_link "$UNIFIED_MPC_RUNTIME_DIR/last-known-good" "$release_a"
grep -Fxq healthy "$UNIFIED_MPC_DEPLOY_STATE_DIR/deploy-a/status"
grep -Fxq "$commit_a" "$UNIFIED_MPC_DEPLOY_STATE_DIR/deploy-a/candidate_build_commit"

outside="$TMP_ROOT/repo/.unified-mpc/worktrees/unsafe"
make_runtime "$outside" "$commit_b"
expect_fail RUNTIME_ROOT_DISPOSABLE bash "$PROMOTER" "$outside" "outside-rejected"
assert_link "$UNIFIED_MPC_RUNTIME_DIR/current" "$release_a"
[[ ! -e "$UNIFIED_MPC_DEPLOY_STATE_DIR/outside-rejected" ]]

release_b="$UNIFIED_MPC_RUNTIME_DIR/releases/deploy-b"
make_runtime "$release_b" "$commit_b"
touch "$release_b/health.fail"
expect_fail RUNTIME_PROMOTION_INCOMPLETE bash "$PROMOTER" "$release_b" "deploy-b"
assert_link "$UNIFIED_MPC_RUNTIME_DIR/current" "$release_a"
assert_link "$UNIFIED_MPC_RUNTIME_DIR/last-known-good" "$release_a"
grep -Fxq rolled_back "$UNIFIED_MPC_DEPLOY_STATE_DIR/deploy-b/status"
grep -Fxq failed "$UNIFIED_MPC_DEPLOY_STATE_DIR/deploy-b/health_result"
grep -Fxq success "$UNIFIED_MPC_DEPLOY_STATE_DIR/deploy-b/rollback_result"

release_c="$UNIFIED_MPC_RUNTIME_DIR/releases/deploy-c"
make_runtime "$release_c" "$commit_c"
bash "$PROMOTER" "$release_c" "deploy-c" >/dev/null
assert_link "$UNIFIED_MPC_RUNTIME_DIR/current" "$release_c"
assert_link "$UNIFIED_MPC_RUNTIME_DIR/last-known-good" "$release_c"
grep -Fxq healthy "$UNIFIED_MPC_DEPLOY_STATE_DIR/deploy-c/status"

release_dirty="$UNIFIED_MPC_RUNTIME_DIR/releases/deploy-dirty"
make_runtime "$release_dirty" "$commit_d" true
expect_fail RUNTIME_PROMOTION_INCOMPLETE bash "$PROMOTER" "$release_dirty" "deploy-dirty"
assert_link "$UNIFIED_MPC_RUNTIME_DIR/current" "$release_c"
[[ ! -e "$UNIFIED_MPC_DEPLOY_STATE_DIR/deploy-dirty" ]]

release_bad="$UNIFIED_MPC_RUNTIME_DIR/releases/deploy-bad"
make_runtime "$release_bad" "$commit_d"
printf '{"buildCommit":"not-a-commit"}\n' >"$release_bad/apps/cli/dist/build-provenance.json"
expect_fail RUNTIME_PROMOTION_INCOMPLETE bash "$PROMOTER" "$release_bad" "deploy-bad"
assert_link "$UNIFIED_MPC_RUNTIME_DIR/current" "$release_c"
[[ ! -e "$UNIFIED_MPC_DEPLOY_STATE_DIR/deploy-bad" ]]

expect_fail RUNTIME_PROMOTION_INCOMPLETE bash "$PROMOTER" "$release_c" "deploy-c"
assert_link "$UNIFIED_MPC_RUNTIME_DIR/current" "$release_c"

# First deployment failure with no last-known-good must leave no active runtime.
export UNIFIED_MPC_RUNTIME_DIR="$TMP_ROOT/data-fresh/unified-mpc/runtime"
export UNIFIED_MPC_DEPLOY_STATE_DIR="$TMP_ROOT/state-fresh/unified-mpc/deployments"
mkdir -p "$UNIFIED_MPC_RUNTIME_DIR/releases"
release_e="$UNIFIED_MPC_RUNTIME_DIR/releases/deploy-e"
make_runtime "$release_e" "$commit_e"
touch "$release_e/health.fail"
expect_fail RUNTIME_PROMOTION_INCOMPLETE bash "$PROMOTER" "$release_e" "deploy-e"
[[ ! -e "$UNIFIED_MPC_RUNTIME_DIR/current" && ! -L "$UNIFIED_MPC_RUNTIME_DIR/current" ]]
grep -Fxq failed_no_rollback "$UNIFIED_MPC_DEPLOY_STATE_DIR/deploy-e/status"
grep -Fxq unavailable "$UNIFIED_MPC_DEPLOY_STATE_DIR/deploy-e/rollback_result"

printf 'runtime promotion regression: passed\n'
