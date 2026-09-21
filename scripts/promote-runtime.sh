#!/usr/bin/env bash
set -euo pipefail

candidate_arg="${1:-}"
deployment_id="${2:-}"

fail() {
  local code="$1"
  shift
  printf '%s\n' "$*" >&2
  exit "$code"
}

if [[ -z "$candidate_arg" || -z "$deployment_id" ]]; then
  fail 64 "RUNTIME_PROMOTION_INCOMPLETE: usage: promote-runtime.sh <release-root> <deployment-id>"
fi

if [[ ! "$deployment_id" =~ ^[A-Za-z0-9._-]+$ ]]; then
  fail 64 "RUNTIME_PROMOTION_INCOMPLETE: deployment id must match [A-Za-z0-9._-]+"
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
validator="${UNIFIED_MPC_VALIDATE_RUNTIME_ROOT:-$script_dir/validate-runtime-root.sh}"
runtime_dir="${UNIFIED_MPC_RUNTIME_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/unified-mpc/runtime}"
state_root="${UNIFIED_MPC_DEPLOY_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/unified-mpc/deployments}"
systemctl_bin="${UNIFIED_MPC_SYSTEMCTL:-systemctl}"
curl_bin="${UNIFIED_MPC_CURL:-curl}"
node_bin="${UNIFIED_MPC_NODE:-node}"
flock_bin="${UNIFIED_MPC_FLOCK:-flock}"
service="${UNIFIED_MPC_SYSTEMD_SERVICE:-unified-mpc.service}"
health_url="${UNIFIED_MPC_HEALTH_URL:-http://127.0.0.1:18765/_unified-mpc/identity}"
health_timeout="${UNIFIED_MPC_HEALTH_TIMEOUT_SECONDS:-10}"

mkdir -p "$runtime_dir/releases" "$state_root"
runtime_dir="$(readlink -f -- "$runtime_dir")"
releases_dir="$(readlink -f -- "$runtime_dir/releases")"
current_link="$runtime_dir/current"
lkg_link="$runtime_dir/last-known-good"

if [[ ! -x "$validator" && ! -f "$validator" ]]; then
  fail 69 "RUNTIME_PROMOTION_INCOMPLETE: runtime validator is unavailable: '$validator'"
fi

if [[ ! -d "$candidate_arg" ]]; then
  fail 66 "RUNTIME_ROOT_INVALID: candidate release does not exist: '$candidate_arg'"
fi

candidate="$(readlink -f -- "$candidate_arg" 2>/dev/null || true)"
if [[ -z "$candidate" || ! -d "$candidate" ]]; then
  fail 66 "RUNTIME_ROOT_INVALID: candidate release cannot be resolved: '$candidate_arg'"
fi

if [[ "$candidate" != "$releases_dir/"* ]]; then
  fail 65 "RUNTIME_ROOT_DISPOSABLE: candidate must be materialized under '$releases_dir': '$candidate'"
fi

bash "$validator" mcp-http "$candidate" >/dev/null
bash "$validator" web "$candidate" >/dev/null

read_provenance() {
  local root="$1"
  "$node_bin" --input-type=commonjs -e '
    try {
      const fs = require("fs");
      const path = process.argv[1];
      const p = JSON.parse(fs.readFileSync(path, "utf8"));
      if (!p || typeof p !== "object") process.exit(2);
      if (typeof p.version !== "string" || p.version.length === 0) process.exit(2);
      if (typeof p.buildCommit !== "string" || !/^[0-9a-f]{40,64}$/i.test(p.buildCommit)) process.exit(2);
      if (typeof p.buildShortCommit !== "string" || p.buildShortCommit.toLowerCase() !== p.buildCommit.slice(0, 12).toLowerCase()) process.exit(2);
      if (typeof p.buildDirty !== "boolean") process.exit(2);
      const expectedVersion = p.version + "+" + p.buildShortCommit + (p.buildDirty ? ".dirty" : "");
      if (p.buildVersion !== expectedVersion) process.exit(2);
      if (typeof p.buildTime !== "string" || Number.isNaN(Date.parse(p.buildTime))) process.exit(2);
      process.stdout.write(p.buildCommit + "\n" + String(p.buildDirty) + "\n");
    } catch {
      process.exit(2);
    }
  ' "$root/apps/cli/dist/build-provenance.json"
}

candidate_provenance_output="$(read_provenance "$candidate" 2>/dev/null)" || fail 67 "RUNTIME_PROMOTION_INCOMPLETE: invalid candidate provenance"
mapfile -t candidate_provenance <<<"$candidate_provenance_output"
candidate_commit="${candidate_provenance[0]:-}"
candidate_dirty="${candidate_provenance[1]:-}"
if [[ -z "$candidate_commit" || "$candidate_dirty" != "false" ]]; then
  fail 67 "RUNTIME_PROMOTION_INCOMPLETE: candidate provenance is invalid or dirty"
fi

exec 9>"$runtime_dir/.promotion.lock"
if ! "$flock_bin" -n 9; then
  fail 75 "RUNTIME_PROMOTION_INCOMPLETE: another runtime promotion is active"
fi

record_dir="$state_root/$deployment_id"
if ! mkdir "$record_dir" 2>/dev/null; then
  fail 73 "RUNTIME_PROMOTION_INCOMPLETE: deployment id already exists: '$deployment_id'"
fi

write_state() {
  local key="$1"
  local value="$2"
  local tmp="$record_dir/.$key.tmp.$$"
  printf '%s\n' "$value" >"$tmp"
  mv -f -- "$tmp" "$record_dir/$key"
}

atomic_link() {
  local target="$1"
  local link="$2"
  local dir base tmp
  dir="$(dirname -- "$link")"
  base="$(basename -- "$link")"
  tmp="$dir/.$base.tmp.$$"
  rm -f -- "$tmp"
  ln -s -- "$target" "$tmp"
  mv -Tf -- "$tmp" "$link"
}

resolve_link() {
  local link="$1"
  if [[ ! -L "$link" ]]; then
    return 1
  fi
  readlink -f -- "$link" 2>/dev/null
}

validate_rollback_target() {
  local target="$1"
  [[ -n "$target" && -d "$target" ]] || return 1
  [[ "$target" == "$releases_dir/"* ]] || return 1
  bash "$validator" mcp-http "$target" >/dev/null 2>&1 || return 1
  bash "$validator" web "$target" >/dev/null 2>&1 || return 1
  read_provenance "$target" >/dev/null 2>&1 || return 1
}

runtime_commit() {
  local root="$1"
  local output
  local -a provenance
  output="$(read_provenance "$root" 2>/dev/null)" || return 1
  mapfile -t provenance <<<"$output"
  printf '%s\n' "${provenance[0]:-}"
}

restart_runtime() {
  "$systemctl_bin" --user restart "$service"
}

probe_runtime() {
  local expected_commit="$1"
  local payload actual_commit
  payload="$("$curl_bin" --fail --silent --show-error --max-time "$health_timeout" "$health_url")" || return 1
  actual_commit="$(printf '%s' "$payload" | "$node_bin" --input-type=commonjs -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      if (!value || typeof value.buildCommit !== "string") process.exit(2);
      process.stdout.write(value.buildCommit);
    });
  ')" || return 1
  [[ "$actual_commit" == "$expected_commit" ]]
}

previous_active=""
if [[ -e "$current_link" && ! -L "$current_link" ]]; then
  write_state status "failed"
  write_state health_result "not_started"
  write_state rollback_result "not_started"
  fail 70 "RUNTIME_PROMOTION_INCOMPLETE: active runtime pointer is not a symlink: '$current_link'"
fi
if [[ -L "$current_link" ]]; then
  previous_active="$(resolve_link "$current_link" || true)"
fi

rollback_target=""
if [[ -L "$lkg_link" ]]; then
  candidate_lkg="$(resolve_link "$lkg_link" || true)"
  if validate_rollback_target "$candidate_lkg"; then
    rollback_target="$candidate_lkg"
  fi
fi
if [[ -z "$rollback_target" && -n "$previous_active" ]] && validate_rollback_target "$previous_active"; then
  rollback_target="$previous_active"
fi

write_state status "pending"
write_state deployment_id "$deployment_id"
write_state candidate_path "$candidate"
write_state candidate_build_commit "$candidate_commit"
write_state previous_active "$previous_active"
write_state rollback_target "$rollback_target"
write_state promoted_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
write_state health_result "pending"
write_state rollback_result "not_needed"

atomic_link "$candidate" "$current_link"
write_state status "activated"

promotion_ok=false
if restart_runtime && probe_runtime "$candidate_commit"; then
  promotion_ok=true
fi

if [[ "$promotion_ok" == "true" ]]; then
  atomic_link "$candidate" "$lkg_link"
  write_state health_result "healthy"
  write_state rollback_result "not_needed"
  write_state status "healthy"
  printf 'RUNTIME_PROMOTION_OK: deployment=%s commit=%s root=%s\n' "$deployment_id" "$candidate_commit" "$candidate"
  exit 0
fi

write_state health_result "failed"
write_state status "rollback_pending"

if [[ -n "$rollback_target" ]]; then
  atomic_link "$rollback_target" "$current_link"
  rollback_commit="$(runtime_commit "$rollback_target" || true)"
  if [[ -n "$rollback_commit" ]] && restart_runtime && probe_runtime "$rollback_commit"; then
    write_state rollback_result "success"
    write_state status "rolled_back"
    printf 'RUNTIME_PROMOTION_INCOMPLETE: candidate failed; rolled back to last-known-good %s\n' "$rollback_target" >&2
    exit 70
  fi
  write_state rollback_result "failed"
  write_state status "rollback_failed"
  printf 'RUNTIME_PROMOTION_INCOMPLETE: candidate failed and rollback health verification failed; LAST_KNOWN_GOOD_AVAILABLE=%s\n' "$rollback_target" >&2
  exit 71
fi

rm -f -- "$current_link"
write_state rollback_result "unavailable"
write_state status "failed_no_rollback"
printf 'RUNTIME_PROMOTION_INCOMPLETE: candidate failed and no last-known-good runtime is available\n' >&2
exit 72
