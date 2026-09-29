#!/usr/bin/env bash
set -euo pipefail

service="${1:-}"
configured_root="${2:-}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
validator="${UNIFIED_MPC_VALIDATE_RUNTIME_ROOT:-$script_dir/validate-runtime-root.sh}"
runtime_dir="${UNIFIED_MPC_RUNTIME_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/unified-mpc/runtime}"
node_bin="${UNIFIED_MPC_NODE:-node}"
unrecoverable_status=78

fail() {
  local code="$1"
  shift
  printf '%s\n' "$*" >&2
  exit "$code"
}

case "$service" in
  mcp-http|web)
    ;;
  *)
    fail "$unrecoverable_status" "RUNTIME_RECOVERY_UNAVAILABLE: unsupported Unified service '$service'"
    ;;
esac

configure_runtime_temp() {
  local runtime_tmp_base=""
  if [[ -n "${XDG_RUNTIME_DIR:-}" ]]; then
    runtime_tmp_base="$XDG_RUNTIME_DIR"
  elif [[ -n "${XDG_CACHE_HOME:-}" ]]; then
    runtime_tmp_base="$XDG_CACHE_HOME"
  elif [[ -n "${HOME:-}" ]]; then
    runtime_tmp_base="$HOME/.cache"
  else
    fail "$unrecoverable_status" "RUNTIME_TMP_UNAVAILABLE: no XDG_RUNTIME_DIR, XDG_CACHE_HOME, or HOME is available"
  fi

  local runtime_tmp="$runtime_tmp_base/unified-mpc/runtime-tmp/$service"
  local compile_cache="$runtime_tmp/node-compile-cache"
  if [[ -L "$runtime_tmp" || -L "$compile_cache" ]]; then
    fail "$unrecoverable_status" "RUNTIME_TMP_UNAVAILABLE: runtime temp path must not be a symlink: '$runtime_tmp'"
  fi
  if ! mkdir -p -- "$runtime_tmp" "$compile_cache"; then
    fail "$unrecoverable_status" "RUNTIME_TMP_UNAVAILABLE: failed to create runtime temp path: '$runtime_tmp'"
  fi
  if ! chmod 700 -- "$runtime_tmp" "$compile_cache"; then
    fail "$unrecoverable_status" "RUNTIME_TMP_UNAVAILABLE: failed to secure runtime temp path: '$runtime_tmp'"
  fi

  local probe=""
  if ! probe="$(mktemp -d -- "$runtime_tmp/.probe.XXXXXX")"; then
    fail "$unrecoverable_status" "RUNTIME_TMP_UNAVAILABLE: runtime temp path is not writable: '$runtime_tmp'"
  fi
  if ! rmdir -- "$probe"; then
    fail "$unrecoverable_status" "RUNTIME_TMP_UNAVAILABLE: runtime temp probe cleanup failed: '$probe'"
  fi

  export TMPDIR="$runtime_tmp"
  export NODE_COMPILE_CACHE="$compile_cache"
  printf 'RUNTIME_TMP_OK: service=%s tmpdir=%s compile_cache=%s\n' "$service" "$TMPDIR" "$NODE_COMPILE_CACHE" >&2
}

configure_runtime_temp

if [[ ! -f "$validator" ]]; then
  fail "$unrecoverable_status" "RUNTIME_RECOVERY_UNAVAILABLE: runtime validator is unavailable: '$validator'"
fi

validate_pair() {
  local root="$1"
  bash "$validator" mcp-http "$root" >/dev/null 2>&1     && bash "$validator" web "$root" >/dev/null 2>&1
}

resolve_valid_pair() {
  local root="$1"
  [[ -n "$root" ]] || return 1
  validate_pair "$root" || return 1
  readlink -f -- "$root" 2>/dev/null
}

runtime_dir_resolved=""
releases_dir_resolved=""
if [[ -d "$runtime_dir" ]]; then
  runtime_dir_resolved="$(readlink -f -- "$runtime_dir" 2>/dev/null || true)"
fi
if [[ -n "$runtime_dir_resolved" && -d "$runtime_dir_resolved/releases" ]]; then
  releases_dir_resolved="$(readlink -f -- "$runtime_dir_resolved/releases" 2>/dev/null || true)"
fi

is_owned_release() {
  local root="$1"
  [[ -n "$releases_dir_resolved" && "$root" == "$releases_dir_resolved/"* ]]
}

chosen_root=""
chosen_source="configured"
if chosen_root="$(resolve_valid_pair "$configured_root" 2>/dev/null)"; then
  :
else
  chosen_root=""
  chosen_source=""

  for source in current last-known-good; do
    pointer="$runtime_dir/$source"
    [[ -L "$pointer" ]] || continue
    candidate="$(readlink -f -- "$pointer" 2>/dev/null || true)"
    [[ -n "$candidate" ]] || continue
    is_owned_release "$candidate" || continue
    validate_pair "$candidate" || continue
    chosen_root="$candidate"
    chosen_source="$source"
    break
  done
fi

if [[ -z "$chosen_root" ]]; then
  printf 'RUNTIME_ROOT_RECONCILIATION_FAILED: service=%s configured=%s\n' "$service" "$configured_root" >&2
  bash "$validator" mcp-http "$configured_root" >&2 || true
  bash "$validator" web "$configured_root" >&2 || true
  fail "$unrecoverable_status" "RUNTIME_RECOVERY_UNAVAILABLE: no valid deployment-owned runtime/current or runtime/last-known-good is available"
fi

if [[ "$chosen_source" == "configured" ]]; then
  printf 'RUNTIME_ROOT_OK: service=%s source=configured root=%s\n' "$service" "$chosen_root" >&2
else
  printf 'RUNTIME_ROOT_RECOVERED: service=%s source=%s configured=%s root=%s\n'     "$service" "$chosen_source" "$configured_root" "$chosen_root" >&2
fi

export UNIFIED_MPC_ROOT="$chosen_root"

case "$service" in
  mcp-http)
    exec "$node_bin" "$chosen_root/apps/cli/dist/bin/mcp-http.js"
    ;;
  web)
    exec "$node_bin" "$chosen_root/apps/cli/dist/index.js" web --port 3000
    ;;
esac
