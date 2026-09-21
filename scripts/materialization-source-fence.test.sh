#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MATERIALIZER="$SCRIPT_DIR/materialize-runtime-release.sh"
VALIDATOR="$SCRIPT_DIR/validate-runtime-root.sh"
TMP_ROOT="$(mktemp -d)"
MATERIALIZER_PID=""
trap 'if [[ -n "$MATERIALIZER_PID" ]]; then kill "$MATERIALIZER_PID" 2>/dev/null || true; wait "$MATERIALIZER_PID" 2>/dev/null || true; fi; rm -rf -- "$TMP_ROOT"' EXIT

repo="$TMP_ROOT/repo"
linked="$TMP_ROOT/linked"
runtime="$TMP_ROOT/runtime"
state="$TMP_ROOT/state/materializations"
ready="$TMP_ROOT/corepack-ready"
release="$TMP_ROOT/corepack-release"

git init -q "$repo"
git -C "$repo" config user.name "Unified Test"
git -C "$repo" config user.email "unified@example.invalid"
printf 'apps/cli/dist/\n' >"$repo/.gitignore"
printf 'fixture\n' >"$repo/README.md"
git -C "$repo" add .gitignore README.md
git -C "$repo" commit -qm "fixture"
git -C "$repo" worktree add -q -b materialization-source-fence "$linked"

commit="$(git -C "$linked" rev-parse --verify HEAD)"
mkdir -p "$linked/apps/cli/dist/bin"
printf 'export {};\n' >"$linked/apps/cli/dist/bin/mcp-http.js"
printf 'export {};\n' >"$linked/apps/cli/dist/index.js"
cat >"$linked/apps/cli/dist/build-provenance.json" <<EOF
{"buildCommit":"$commit","buildDirty":false}
EOF
[[ -z "$(git -C "$linked" status --porcelain)" ]]

fake_corepack="$TMP_ROOT/corepack"
cat >"$fake_corepack" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
out="${@: -1}"
touch "$UNIFIED_MPC_TEST_COREPACK_READY"
while [[ ! -e "$UNIFIED_MPC_TEST_COREPACK_RELEASE" ]]; do
  sleep 0.05
done
mkdir -p "$out/dist/bin" "$out/node_modules"
printf 'export {};\n' >"$out/dist/bin/mcp-http.js"
printf 'export {};\n' >"$out/dist/index.js"
cp apps/cli/dist/build-provenance.json "$out/dist/build-provenance.json"
SH
chmod +x "$fake_corepack"

export UNIFIED_MPC_RUNTIME_DIR="$runtime"
export UNIFIED_MPC_MATERIALIZE_STATE_DIR="$state"
export UNIFIED_MPC_VALIDATE_RUNTIME_ROOT="$VALIDATOR"
export UNIFIED_MPC_COREPACK="$fake_corepack"
export UNIFIED_MPC_TEST_COREPACK_READY="$ready"
export UNIFIED_MPC_TEST_COREPACK_RELEASE="$release"

bash "$MATERIALIZER" deploy-fence "$linked" >"$TMP_ROOT/materializer.log" 2>&1 &
MATERIALIZER_PID=$!

for _ in $(seq 1 200); do
  [[ -e "$ready" ]] && break
  kill -0 "$MATERIALIZER_PID" 2>/dev/null || {
    cat "$TMP_ROOT/materializer.log" >&2
    exit 1
  }
  sleep 0.05
done
[[ -e "$ready" ]] || {
  printf 'materializer did not reach the blocked deploy phase\n' >&2
  exit 1
}

grep -Fxq materializing "$state/deploy-fence/status"
grep -Fxq "$(readlink -f -- "$linked")" "$state/deploy-fence/source_path"

set +e
remove_output="$(git -C "$repo" worktree remove "$linked" 2>&1)"
remove_status=$?
set -e
[[ "$remove_status" -ne 0 ]] || {
  printf 'locked source worktree was removed during materialization\n' >&2
  exit 1
}
grep -qi 'locked' <<<"$remove_output"

touch "$release"
wait "$MATERIALIZER_PID"
MATERIALIZER_PID=""

grep -Fxq published "$state/deploy-fence/status"
test -f "$runtime/releases/deploy-fence/runtime-release.json"

git -C "$repo" worktree remove "$linked"
[[ ! -e "$linked" ]]

printf 'runtime materialization source fence: passed\n'
