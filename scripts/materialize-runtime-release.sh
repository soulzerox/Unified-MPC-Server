#!/usr/bin/env bash
set -euo pipefail

deployment_id="${1:-}"
source_arg="${2:-$PWD}"

fail() {
  local code="$1"
  shift
  printf '%s\n' "$*" >&2
  exit "$code"
}

if [[ -z "$deployment_id" ]]; then
  fail 64 "RUNTIME_RELEASE_INCOMPLETE: usage: materialize-runtime-release.sh <deployment-id> [source-root]"
fi
if [[ ! "$deployment_id" =~ ^[A-Za-z0-9._-]+$ ]]; then
  fail 64 "RUNTIME_RELEASE_INCOMPLETE: deployment id must match [A-Za-z0-9._-]+"
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
validator="${UNIFIED_MPC_VALIDATE_RUNTIME_ROOT:-$script_dir/validate-runtime-root.sh}"
runtime_dir="${UNIFIED_MPC_RUNTIME_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/unified-mpc/runtime}"
git_bin="${UNIFIED_MPC_GIT:-git}"
node_bin="${UNIFIED_MPC_NODE:-node}"
corepack_bin="${UNIFIED_MPC_COREPACK:-corepack}"
flock_bin="${UNIFIED_MPC_FLOCK:-flock}"

if [[ ! -d "$source_arg" ]]; then
  fail 66 "RUNTIME_RELEASE_INCOMPLETE: source root does not exist: '$source_arg'"
fi
source_root="$(readlink -f -- "$source_arg" 2>/dev/null || true)"
if [[ -z "$source_root" || ! -d "$source_root" ]]; then
  fail 66 "RUNTIME_RELEASE_INCOMPLETE: source root cannot be resolved: '$source_arg'"
fi

git_root="$("$git_bin" -C "$source_root" rev-parse --show-toplevel 2>/dev/null || true)"
git_root="$(readlink -f -- "$git_root" 2>/dev/null || true)"
if [[ -z "$git_root" || "$git_root" != "$source_root" ]]; then
  fail 65 "RUNTIME_RELEASE_INCOMPLETE: source root must be the Git worktree root: '$source_root'"
fi

source_commit="$("$git_bin" -C "$source_root" rev-parse --verify HEAD 2>/dev/null || true)"
if [[ ! "$source_commit" =~ ^[0-9a-fA-F]{40,64}$ ]]; then
  fail 67 "RUNTIME_RELEASE_INCOMPLETE: cannot resolve source build commit"
fi
if [[ -n "$("$git_bin" -C "$source_root" status --porcelain)" ]]; then
  fail 67 "RUNTIME_RELEASE_INCOMPLETE: source worktree must be clean before materialization"
fi

source_provenance="$source_root/apps/cli/dist/build-provenance.json"
if [[ ! -f "$source_provenance" ]]; then
  fail 67 "RUNTIME_ARTIFACT_MISSING: build CLI first; provenance is missing: '$source_provenance'"
fi

source_provenance_output="$("$node_bin" --input-type=commonjs -e '
  const fs = require("fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!value || typeof value.buildCommit !== "string" || typeof value.buildDirty !== "boolean") process.exit(2);
  process.stdout.write(value.buildCommit + "\n" + String(value.buildDirty) + "\n");
' "$source_provenance" 2>/dev/null)" || fail 67 "RUNTIME_RELEASE_INCOMPLETE: source provenance is malformed"
mapfile -t source_provenance_values <<<"$source_provenance_output"
artifact_commit="${source_provenance_values[0]:-}"
artifact_dirty="${source_provenance_values[1]:-}"
if [[ "$artifact_commit" != "$source_commit" || "$artifact_dirty" != "false" ]]; then
  fail 67 "RUNTIME_RELEASE_INCOMPLETE: built provenance must match clean source HEAD"
fi

mkdir -p "$runtime_dir/releases"
runtime_dir="$(readlink -f -- "$runtime_dir")"
releases_dir="$(readlink -f -- "$runtime_dir/releases")"
release_root="$releases_dir/$deployment_id"
stage_root="$releases_dir/.$deployment_id.materializing.$$"

if [[ -e "$release_root" || -L "$release_root" ]]; then
  fail 73 "RUNTIME_RELEASE_INCOMPLETE: release already exists: '$release_root'"
fi
if [[ ! -x "$validator" && ! -f "$validator" ]]; then
  fail 69 "RUNTIME_RELEASE_INCOMPLETE: runtime validator is unavailable: '$validator'"
fi

exec 9>"$runtime_dir/.materialization.lock"
if ! "$flock_bin" -n 9; then
  fail 75 "RUNTIME_RELEASE_INCOMPLETE: another runtime materialization is active"
fi

cleanup_stage() {
  rm -rf -- "$stage_root"
}
trap cleanup_stage EXIT
mkdir -p "$stage_root/apps"

(
  cd "$source_root"
  "$corepack_bin" pnpm --prefer-offline --filter @unified-mpc/cli --prod deploy --legacy "$stage_root/apps/cli"
)

bash "$validator" mcp-http "$stage_root" >/dev/null
bash "$validator" web "$stage_root" >/dev/null

# pnpm's legacy deploy can leave one metadata-only self-reference for the
# deployed package itself. It is not a runtime dependency, but if retained it
# would keep the release coupled to the source worktree. Remove only that
# exact self-link when it resolves back to this source package; any other
# escaping symlink remains a hard portability failure below.
pnpm_self_link="$stage_root/apps/cli/node_modules/.pnpm/node_modules/@unified-mpc/cli"
if [[ -L "$pnpm_self_link" ]]; then
  pnpm_self_target="$(readlink -f -- "$pnpm_self_link" 2>/dev/null || true)"
  expected_self_target="$(readlink -f -- "$source_root/apps/cli" 2>/dev/null || true)"
  if [[ -n "$pnpm_self_target" && "$pnpm_self_target" == "$expected_self_target" ]]; then
    rm -f -- "$pnpm_self_link"
  fi
fi

deployed_provenance="$stage_root/apps/cli/dist/build-provenance.json"
deployed_commit="$("$node_bin" --input-type=commonjs -e '
  const fs = require("fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!value || typeof value.buildCommit !== "string" || value.buildDirty !== false) process.exit(2);
  process.stdout.write(value.buildCommit);
' "$deployed_provenance" 2>/dev/null)" || fail 67 "RUNTIME_RELEASE_INCOMPLETE: deployed provenance is malformed or dirty"
if [[ "$deployed_commit" != "$source_commit" ]]; then
  fail 67 "RUNTIME_RELEASE_INCOMPLETE: deployed provenance does not match source HEAD"
fi

while IFS= read -r -d '' link; do
  raw_target="$(readlink -- "$link" 2>/dev/null || true)"
  resolved="$(readlink -f -- "$link" 2>/dev/null || true)"
  if [[ "$raw_target" == /* ]]; then
    fail 68 "RUNTIME_RELEASE_NOT_PORTABLE: absolute symlink would not survive atomic release rename: '$link' -> '$raw_target'"
  fi
  if [[ -z "$resolved" || ( "$resolved" != "$stage_root" && "$resolved" != "$stage_root/"* ) ]]; then
    fail 68 "RUNTIME_RELEASE_NOT_PORTABLE: symlink escapes release root: '$link' -> '$resolved'"
  fi
done < <(find "$stage_root" -type l -print0)

materialized_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat >"$stage_root/runtime-release.json" <<EOF
{
  "schemaVersion": 1,
  "deploymentId": "$deployment_id",
  "buildCommit": "$source_commit",
  "materializedAt": "$materialized_at"
}
EOF

mv -- "$stage_root" "$release_root"
trap - EXIT
printf 'RUNTIME_RELEASE_OK: deployment=%s commit=%s root=%s\n' "$deployment_id" "$source_commit" "$release_root"
