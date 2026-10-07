#!/usr/bin/env bash
set -eEuo pipefail
unexpected_err() {
  local status=$?
  printf 'promotion regression failed at line %s: %s (status=%s)\n' "$LINENO" "$BASH_COMMAND" "$status" >&2
  exit "$status"
}
trap unexpected_err ERR

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
export UNIFIED_MPC_TEST_SYSTEMD_RUN_LOG="$TMP_ROOT/systemd-run.log"
export UNIFIED_MPC_SELF_CGROUP_FILE="$TMP_ROOT/self.cgroup"
export UNIFIED_MPC_TEST_TRANSIENT_CGROUP_FILE="$TMP_ROOT/transient.cgroup"
export UNIFIED_MPC_READINESS_TIMEOUT_SECONDS="1"
export UNIFIED_MPC_READINESS_RETRY_INTERVAL_SECONDS="0.05"

mkdir -p "$HOME" "$UNIFIED_MPC_RUNTIME_DIR/releases" "$TMP_ROOT/bin"
printf '0::/user.slice/test-session.scope\n' >"$UNIFIED_MPC_SELF_CGROUP_FILE"
printf '0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-u12345.service\n' >"$UNIFIED_MPC_TEST_TRANSIENT_CGROUP_FILE"

cat >"$TMP_ROOT/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$UNIFIED_MPC_TEST_SYSTEMCTL_LOG"
if [[ "${UNIFIED_MPC_TEST_REQUIRE_DELEGATED_RESTART:-}" == "1" && "${UNIFIED_MPC_PROMOTION_DELEGATED:-}" != "1" ]]; then
  printf 'self-hosted restart was not delegated outside the runtime service cgroup\n' >&2
  exit 99
fi
exit 0
EOF

cat >"$TMP_ROOT/bin/systemd-run" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
env_args=()
command_args=()
while (($# > 0)); do
  case "$1" in
    --user|--wait|--collect|--quiet)
      shift
      ;;
    --setenv=*)
      env_args+=("${1#--setenv=}")
      shift
      ;;
    --)
      shift
      command_args=("$@")
      break
      ;;
    -*)
      printf 'unsupported fake systemd-run option: %s\n' "$1" >&2
      exit 98
      ;;
    *)
      command_args=("$@")
      break
      ;;
  esac
done
printf '%s\n' "${command_args[*]}" >>"$UNIFIED_MPC_TEST_SYSTEMD_RUN_LOG"
((${#command_args[@]} > 0)) || exit 97
if [[ -n "${UNIFIED_MPC_TEST_TRANSIENT_CGROUP_FILE:-}" ]]; then
  env_args+=("UNIFIED_MPC_SELF_CGROUP_FILE=$UNIFIED_MPC_TEST_TRANSIENT_CGROUP_FILE")
fi
exec env "${env_args[@]}" "${command_args[@]}"
EOF

cat >"$TMP_ROOT/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
url="${!#}"
active="$(readlink -f -- "$UNIFIED_MPC_RUNTIME_DIR/current" 2>/dev/null || true)"
[[ -n "$active" && -d "$active" ]] || exit 7
[[ ! -f "$active/health.fail" ]] || exit 22
provenance="$active/apps/cli/dist/build-provenance.json"

should_fail_probe() {
  local kind="$1"
  local configured="$active/$kind.fail-count"
  local counter="$active/.$kind.probe-count"
  local attempt=0 failures=0
  if [[ -f "$counter" ]]; then
    read -r attempt <"$counter" || true
  fi
  attempt=$((attempt + 1))
  printf '%s\n' "$attempt" >"$counter"
  if [[ -f "$configured" ]]; then
    read -r failures <"$configured" || true
    [[ "$failures" =~ ^[0-9]+$ ]] || exit 97
    if (( attempt <= failures )); then
      return 0
    fi
  fi
  return 1
}

if [[ "$url" == *":3000/api/status" ]]; then
  [[ ! -f "$active/web.fail" ]] || exit 22
  if should_fail_probe web; then
    exit 22
  fi
  printf '{"status":"healthy","mcpIdentity":'
  cat "$provenance"
  printf '}\n'
else
  [[ ! -f "$active/mcp.fail" ]] || exit 22
  if should_fail_probe mcp; then
    exit 22
  fi
  cat "$provenance"
fi
EOF

chmod +x "$TMP_ROOT/bin/systemctl" "$TMP_ROOT/bin/systemd-run" "$TMP_ROOT/bin/curl"
export UNIFIED_MPC_SYSTEMCTL="$TMP_ROOT/bin/systemctl"
export UNIFIED_MPC_SYSTEMD_RUN="$TMP_ROOT/bin/systemd-run"
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
  trap - ERR
  set +e
  output="$("$@" 2>&1)"
  status=$?
  set -e
  trap unexpected_err ERR
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
commit_f="ffffffffffffffffffffffffffffffffffffffff"
commit_g="9999999999999999999999999999999999999999"
commit_h="8888888888888888888888888888888888888888"
commit_i="7777777777777777777777777777777777777777"

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
# MCP identity succeeds but Web status fails: promotion must still roll back.
touch "$release_b/web.fail"
expect_fail RUNTIME_PROMOTION_INCOMPLETE bash "$PROMOTER" "$release_b" "deploy-b"
assert_link "$UNIFIED_MPC_RUNTIME_DIR/current" "$release_a"
assert_link "$UNIFIED_MPC_RUNTIME_DIR/last-known-good" "$release_a"
grep -Fxq rolled_back "$UNIFIED_MPC_DEPLOY_STATE_DIR/deploy-b/status"
grep -Fxq failed "$UNIFIED_MPC_DEPLOY_STATE_DIR/deploy-b/health_result"
grep -Fxq web_request_failed "$UNIFIED_MPC_DEPLOY_STATE_DIR/deploy-b/health_failure_detail"
grep -Fxq success "$UNIFIED_MPC_DEPLOY_STATE_DIR/deploy-b/rollback_result"
grep -Fxq none "$UNIFIED_MPC_DEPLOY_STATE_DIR/deploy-b/rollback_health_failure_detail"

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

# Delayed MCP/Web readiness must be retried instead of rolling back after the first probe.
release_slow="$UNIFIED_MPC_RUNTIME_DIR/releases/deploy-slow"
make_runtime "$release_slow" "$commit_f"
printf '1\n' >"$release_slow/mcp.fail-count"
printf '2\n' >"$release_slow/web.fail-count"
bash "$PROMOTER" "$release_slow" "deploy-slow" >/dev/null
assert_link "$UNIFIED_MPC_RUNTIME_DIR/current" "$release_slow"
assert_link "$UNIFIED_MPC_RUNTIME_DIR/last-known-good" "$release_slow"
grep -Fxq healthy "$UNIFIED_MPC_DEPLOY_STATE_DIR/deploy-slow/status"
grep -Fxq 4 "$release_slow/.mcp.probe-count"
grep -Fxq 3 "$release_slow/.web.probe-count"

# First deployment with no last-known-good must tolerate slow readiness and promote once healthy.
export UNIFIED_MPC_RUNTIME_DIR="$TMP_ROOT/data-fresh-slow/unified-mpc/runtime"
export UNIFIED_MPC_DEPLOY_STATE_DIR="$TMP_ROOT/state-fresh-slow/unified-mpc/deployments"
mkdir -p "$UNIFIED_MPC_RUNTIME_DIR/releases"
release_g="$UNIFIED_MPC_RUNTIME_DIR/releases/deploy-g"
make_runtime "$release_g" "$commit_g"
printf '2\n' >"$release_g/web.fail-count"
bash "$PROMOTER" "$release_g" "deploy-g" >/dev/null
assert_link "$UNIFIED_MPC_RUNTIME_DIR/current" "$release_g"
assert_link "$UNIFIED_MPC_RUNTIME_DIR/last-known-good" "$release_g"
grep -Fxq healthy "$UNIFIED_MPC_DEPLOY_STATE_DIR/deploy-g/status"
grep -Fxq 3 "$release_g/.web.probe-count"

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
grep -Fxq mcp_request_failed "$UNIFIED_MPC_DEPLOY_STATE_DIR/deploy-e/health_failure_detail"
grep -Fxq unavailable "$UNIFIED_MPC_DEPLOY_STATE_DIR/deploy-e/rollback_result"

# A promoter launched from a Unified runtime service cgroup must delegate the real
# transaction before restart so the service restart cannot kill the transaction.
export UNIFIED_MPC_RUNTIME_DIR="$TMP_ROOT/data-self-hosted/unified-mpc/runtime"
export UNIFIED_MPC_DEPLOY_STATE_DIR="$TMP_ROOT/state-self-hosted/unified-mpc/deployments"
mkdir -p "$UNIFIED_MPC_RUNTIME_DIR/releases"
printf '0::/user.slice/user-1000.slice/user@1000.service/app.slice/test-session.scope\n' >"$UNIFIED_MPC_SELF_CGROUP_FILE"
release_self_base="$UNIFIED_MPC_RUNTIME_DIR/releases/self-base"
make_runtime "$release_self_base" "$commit_g"
bash "$PROMOTER" "$release_self_base" "self-base" >/dev/null
assert_link "$UNIFIED_MPC_RUNTIME_DIR/current" "$release_self_base"
assert_link "$UNIFIED_MPC_RUNTIME_DIR/last-known-good" "$release_self_base"

printf '0::/user.slice/user-1000.slice/user@1000.service/app.slice/unified-mpc-mcp-http.service\n' >"$UNIFIED_MPC_SELF_CGROUP_FILE"
export UNIFIED_MPC_TEST_REQUIRE_DELEGATED_RESTART=1
release_self="$UNIFIED_MPC_RUNTIME_DIR/releases/self-hosted"
make_runtime "$release_self" "$commit_h"
bash "$PROMOTER" "$release_self" "self-hosted" >/dev/null
assert_link "$UNIFIED_MPC_RUNTIME_DIR/current" "$release_self"
assert_link "$UNIFIED_MPC_RUNTIME_DIR/last-known-good" "$release_self"
grep -Fxq healthy "$UNIFIED_MPC_DEPLOY_STATE_DIR/self-hosted/status"

release_self_bad="$UNIFIED_MPC_RUNTIME_DIR/releases/self-hosted-bad"
make_runtime "$release_self_bad" "$commit_i"
touch "$release_self_bad/web.fail"
expect_fail RUNTIME_PROMOTION_INCOMPLETE bash "$PROMOTER" "$release_self_bad" "self-hosted-bad"
assert_link "$UNIFIED_MPC_RUNTIME_DIR/current" "$release_self"
assert_link "$UNIFIED_MPC_RUNTIME_DIR/last-known-good" "$release_self"
grep -Fxq rolled_back "$UNIFIED_MPC_DEPLOY_STATE_DIR/self-hosted-bad/status"
grep -Fxq success "$UNIFIED_MPC_DEPLOY_STATE_DIR/self-hosted-bad/rollback_result"
[[ "$(wc -l <"$UNIFIED_MPC_TEST_SYSTEMD_RUN_LOG")" -eq 2 ]]
unset UNIFIED_MPC_TEST_REQUIRE_DELEGATED_RESTART
printf '0::/user.slice/test-session.scope\n' >"$UNIFIED_MPC_SELF_CGROUP_FILE"

printf 'runtime promotion regression: passed\n'
