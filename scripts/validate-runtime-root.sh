#!/usr/bin/env bash
set -euo pipefail

service="${1:-}"
runtime_root="${2:-}"

fail() {
  local code="$1"
  shift
  printf '%s\n' "$*" >&2
  exit "$code"
}

is_disposable_runtime_root() {
  local candidate="$1"
  case "$candidate/" in
    */.unified-mpc/worktrees/*|*/.worktrees/*|*/goal-workspaces/*|*/delegated-workspaces/*|*/inspection-workspaces/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

case "$service" in
  mcp-http)
    entrypoint="apps/cli/dist/bin/mcp-http.js"
    ;;
  web)
    entrypoint="apps/cli/dist/index.js"
    ;;
  *)
    fail 64 "RUNTIME_ROOT_INVALID: unsupported Unified service '$service'"
    ;;
esac

if [[ -z "$runtime_root" ]]; then
  fail 64 "RUNTIME_ROOT_INVALID: UNIFIED_MPC_ROOT is empty"
fi

if [[ "$runtime_root" != /* ]]; then
  fail 64 "RUNTIME_ROOT_INVALID: UNIFIED_MPC_ROOT must be an absolute path"
fi

if is_disposable_runtime_root "$runtime_root"; then
  fail 65 "RUNTIME_ROOT_DISPOSABLE: refusing managed worktree/workspace root '$runtime_root'"
fi

if [[ ! -d "$runtime_root" ]]; then
  fail 66 "RUNTIME_ROOT_INVALID: runtime root does not exist: '$runtime_root'"
fi

resolved_root="$(readlink -f -- "$runtime_root" 2>/dev/null || true)"
if [[ -z "$resolved_root" || ! -d "$resolved_root" ]]; then
  fail 66 "RUNTIME_ROOT_INVALID: runtime root cannot be resolved: '$runtime_root'"
fi

if is_disposable_runtime_root "$resolved_root"; then
  fail 65 "RUNTIME_ROOT_DISPOSABLE: runtime root resolves to managed worktree/workspace '$resolved_root'"
fi

# A linked Git worktree has a .git *file* pointing back to the common Git dir,
# whereas a canonical checkout normally has a .git directory. Reject linked
# worktrees even when they live outside Unified's conventional path prefixes.
if [[ -f "$resolved_root/.git" ]]; then
  fail 65 "RUNTIME_ROOT_DISPOSABLE: refusing linked Git worktree runtime root '$resolved_root'"
fi

if [[ ! -f "$resolved_root/$entrypoint" ]]; then
  fail 67 "RUNTIME_ARTIFACT_MISSING: expected service entrypoint '$resolved_root/$entrypoint'"
fi

provenance="$resolved_root/apps/cli/dist/build-provenance.json"
if [[ ! -f "$provenance" ]]; then
  fail 67 "RUNTIME_ARTIFACT_MISSING: expected build provenance '$provenance'"
fi

printf 'RUNTIME_ROOT_OK: service=%s root=%s\n' "$service" "$resolved_root"
