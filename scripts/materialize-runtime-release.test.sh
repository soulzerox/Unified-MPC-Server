#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
TMP_ROOT="$(mktemp -d)"
hidden_root="$TMP_ROOT/source-hidden"
source_hidden=false

restore_source() {
  if [[ "$source_hidden" == "true" ]]; then
    mv -- "$hidden_root/apps" "$REPO_ROOT/apps"
    mv -- "$hidden_root/packages" "$REPO_ROOT/packages"
  fi
  rm -rf -- "$TMP_ROOT"
}
trap restore_source EXIT

export UNIFIED_MPC_RUNTIME_DIR="$TMP_ROOT/runtime"
export UNIFIED_MPC_MATERIALIZE_STATE_DIR="$TMP_ROOT/materializations"
export UNIFIED_MPC_VALIDATE_RUNTIME_ROOT="$SCRIPT_DIR/validate-runtime-root.sh"

commit="$(git -C "$REPO_ROOT" rev-parse --verify HEAD)"
deployment_id="portable-${commit:0:12}"

bash "$SCRIPT_DIR/materialize-runtime-release.sh" "$deployment_id" "$REPO_ROOT" >"$TMP_ROOT/materialize.log"
release="$UNIFIED_MPC_RUNTIME_DIR/releases/$deployment_id"

grep -Fxq published "$UNIFIED_MPC_MATERIALIZE_STATE_DIR/$deployment_id/status"
grep -Fxq "$REPO_ROOT" "$UNIFIED_MPC_MATERIALIZE_STATE_DIR/$deployment_id/source_path"
test -f "$release/runtime-release.json"
test -f "$release/apps/cli/dist/bin/mcp-http.js"
test -f "$release/apps/cli/dist/index.js"
test -d "$release/apps/cli/node_modules"
test ! -e "$release/apps/cli/node_modules/.pnpm/node_modules/@unified-mpc/cli"

while IFS= read -r -d '' link; do
  raw_target="$(readlink -- "$link" 2>/dev/null || true)"
  resolved="$(readlink -f -- "$link" 2>/dev/null || true)"
  [[ "$raw_target" != /* ]] || {
    printf 'release contains absolute symlink: %s -> %s\n' "$link" "$raw_target" >&2
    exit 1
  }
  [[ -n "$resolved" && ( "$resolved" == "$release" || "$resolved" == "$release/"* ) ]] || {
    printf 'release contains escaping symlink: %s -> %s\n' "$link" "$resolved" >&2
    exit 1
  }
done < <(find "$release" -type l -print0)

bash "$SCRIPT_DIR/validate-runtime-root.sh" mcp-http "$release" >/dev/null
bash "$SCRIPT_DIR/validate-runtime-root.sh" web "$release" >/dev/null

release_commit="$(node --input-type=commonjs -e '
  const fs = require("fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(value.buildCommit);
' "$release/runtime-release.json")"
[[ "$release_commit" == "$commit" ]]

mkdir -p "$hidden_root"
mv -- "$REPO_ROOT/apps" "$hidden_root/apps"
mv -- "$REPO_ROOT/packages" "$hidden_root/packages"
source_hidden=true

node "$SCRIPT_DIR/smoke-materialized-runtime.mjs" "$release"

mv -- "$hidden_root/apps" "$REPO_ROOT/apps"
mv -- "$hidden_root/packages" "$REPO_ROOT/packages"
source_hidden=false

[[ -z "$(git -C "$REPO_ROOT" status --porcelain)" ]]
printf 'runtime release portability regression: passed\n'
