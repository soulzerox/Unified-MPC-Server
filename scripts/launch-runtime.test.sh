#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
LAUNCHER="$SCRIPT_DIR/launch-runtime.sh"
VALIDATOR="$SCRIPT_DIR/validate-runtime-root.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$TMP_ROOT"' EXIT

export HOME="$TMP_ROOT/home"
export XDG_DATA_HOME="$TMP_ROOT/data"
export UNIFIED_MPC_RUNTIME_DIR="$XDG_DATA_HOME/unified-mpc/runtime"
export UNIFIED_MPC_VALIDATE_RUNTIME_ROOT="$VALIDATOR"
mkdir -p "$HOME" "$UNIFIED_MPC_RUNTIME_DIR/releases"

NODE_LOG="$TMP_ROOT/node.log"
FAKE_NODE="$TMP_ROOT/fake-node"
cat >"$FAKE_NODE" <<'SH'
#!/usr/bin/env bash
printf '%s|%s\n' "$UNIFIED_MPC_ROOT" "$*" >>"$UNIFIED_MPC_TEST_NODE_LOG"
SH
chmod +x "$FAKE_NODE"
export UNIFIED_MPC_NODE="$FAKE_NODE"
export UNIFIED_MPC_TEST_NODE_LOG="$NODE_LOG"

make_runtime() {
  local root="$1"
  mkdir -p "$root/apps/cli/dist/bin"
  printf 'export {};\n' >"$root/apps/cli/dist/bin/mcp-http.js"
  printf 'export {};\n' >"$root/apps/cli/dist/index.js"
  printf '{}\n' >"$root/apps/cli/dist/build-provenance.json"
}

reset_log() {
  : >"$NODE_LOG"
}

assert_last_root() {
  local expected="$1"
  local line actual
  line="$(tail -n 1 "$NODE_LOG")"
  actual="${line%%|*}"
  [[ "$actual" == "$expected" ]] || {
    printf 'expected runtime root %s, got %s\n' "$expected" "$actual" >&2
    exit 1
  }
}

configured="$TMP_ROOT/canonical"
make_runtime "$configured"
reset_log
output="$(bash "$LAUNCHER" mcp-http "$configured" 2>&1)"
grep -Fq 'RUNTIME_ROOT_OK:' <<<"$output"
assert_last_root "$(readlink -f -- "$configured")"

release_current="$UNIFIED_MPC_RUNTIME_DIR/releases/current-release"
make_runtime "$release_current"
ln -s "$release_current" "$UNIFIED_MPC_RUNTIME_DIR/current"

stale="$TMP_ROOT/repo/.unified-mpc/worktrees/stale-runtime"
make_runtime "$stale"
reset_log
output="$(bash "$LAUNCHER" mcp-http "$stale" 2>&1)"
grep -Fq 'RUNTIME_ROOT_RECOVERED:' <<<"$output"
grep -Fq 'source=current' <<<"$output"
assert_last_root "$(readlink -f -- "$release_current")"

split="$TMP_ROOT/split-runtime"
make_runtime "$split"
rm "$split/apps/cli/dist/index.js"
reset_log
output="$(bash "$LAUNCHER" mcp-http "$split" 2>&1)"
grep -Fq 'source=current' <<<"$output"
assert_last_root "$(readlink -f -- "$release_current")"

rm "$UNIFIED_MPC_RUNTIME_DIR/current"
release_lkg="$UNIFIED_MPC_RUNTIME_DIR/releases/lkg-release"
make_runtime "$release_lkg"
ln -s "$release_lkg" "$UNIFIED_MPC_RUNTIME_DIR/last-known-good"
reset_log
output="$(bash "$LAUNCHER" web "$TMP_ROOT/missing-runtime" 2>&1)"
grep -Fq 'source=last-known-good' <<<"$output"
assert_last_root "$(readlink -f -- "$release_lkg")"
grep -Fq ' web --port 3000' "$NODE_LOG"

outside="$TMP_ROOT/outside-valid-runtime"
make_runtime "$outside"
rm "$UNIFIED_MPC_RUNTIME_DIR/last-known-good"
ln -s "$outside" "$UNIFIED_MPC_RUNTIME_DIR/last-known-good"
reset_log
set +e
output="$(bash "$LAUNCHER" web "$TMP_ROOT/missing-runtime" 2>&1)"
status=$?
set -e
[[ "$status" -eq 78 ]] || {
  printf 'expected unrecoverable status 78, got %s: %s\n' "$status" "$output" >&2
  exit 1
}
grep -Fq 'RUNTIME_RECOVERY_UNAVAILABLE:' <<<"$output"
[[ ! -s "$NODE_LOG" ]] || {
  printf 'node must not start without a safe deployment-owned fallback\n' >&2
  exit 1
}

printf 'runtime startup reconciliation: passed\n'
