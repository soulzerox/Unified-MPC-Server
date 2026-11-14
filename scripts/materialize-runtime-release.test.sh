#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
TMP_ROOT=""
hidden_root=""
source_hidden=false

restore_hidden_source() {
  if [[ -n "$hidden_root" && -d "$hidden_root/apps" ]]; then
    mv -- "$hidden_root/apps" "$REPO_ROOT/apps"
  fi
  if [[ -n "$hidden_root" && -d "$hidden_root/packages" ]]; then
    mv -- "$hidden_root/packages" "$REPO_ROOT/packages"
  fi
  source_hidden=false
}

restore_source() {
  # A signal can land between the two moves below, so restore per directory
  # rather than assuming the pair is all-or-nothing.
  if [[ "$source_hidden" == "true" ]]; then
    restore_hidden_source
  fi
  if [[ -n "$TMP_ROOT" ]]; then
    rm -rf -- "$TMP_ROOT"
  fi
}
# Installed before the temp root is chosen: choosing it can refuse, and a
# refusal must not leave a directory behind.
trap restore_source EXIT

# Mirrors `is_disposable_runtime_root` in validate-runtime-root.sh. The
# materializer validates its stage root, so a temp parent under one of those
# prefixes fails the run with RUNTIME_ROOT_DISPOSABLE before any assertion.
is_managed_runtime_path() {
  case "$1/" in
    */.unified-mpc/worktrees/*|*/.worktrees/*|*/goal-workspaces/*|*/delegated-workspaces/*|*/inspection-workspaces/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# #835: the release must be produced on the same filesystem as the checkout.
# pnpm falls back to `copyFileSync` when a hard link crosses devices, so a temp
# root on another filesystem would make the deploy copy and the hard-link
# regression vacuous while still passing. `.unified-mpc/` is ignored by Git, so
# the checkout stays clean. This checkout is tried first, then the primary
# checkout (this repository's goal worktrees live under one of the managed
# prefixes above, so their own `.unified-mpc/` cannot be used), then the system
# temp dir.
temp_parents=("$REPO_ROOT/.unified-mpc")
common_git_dir="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [[ -n "$common_git_dir" ]]; then
  temp_parents+=("$(dirname -- "$common_git_dir")/.unified-mpc")
fi
temp_parents+=("${TMPDIR:-/tmp}")

for temp_parent in "${temp_parents[@]}"; do
  if ! mkdir -p -- "$temp_parent" 2>/dev/null; then
    continue
  fi
  candidate="$(mktemp -d -p "$temp_parent" materialize-test.XXXXXX 2>/dev/null)" || continue
  if [[ "$(stat -c '%d' -- "$candidate")" != "$(stat -c '%d' -- "$REPO_ROOT")" ]]; then
    rm -rf -- "$candidate"
    continue
  fi
  if is_managed_runtime_path "$candidate"; then
    rm -rf -- "$candidate"
    continue
  fi
  TMP_ROOT="$candidate"
  break
done

if [[ -z "$TMP_ROOT" ]]; then
  printf 'no temp directory on the checkout filesystem outside the managed runtime prefixes (%s); the hard-link regression cannot be exercised\n' "${temp_parents[*]}" >&2
  exit 1
fi
hidden_root="$TMP_ROOT/source-hidden"

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

# #835: the release must own its bytes. pnpm's legacy deploy imports local
# `file:` workspace packages by hard link, so every deployed dist shared an
# inode with the checkout and a rebuild rewrote the release in place.
#
# A link count of 1 *is* the proof, not a proxy for it: it means no other path
# to that inode exists, so no rebuild anywhere can reach the release file. The
# tempting stronger-looking check — append to the checkout's dist and watch the
# release stay unchanged — is unsafe to run here: on a host whose live releases
# were materialized from this same checkout, the checkout file is itself a path
# into a published release, so the test would write into production to prove
# that writes do not reach production.
shared_release_files="$(find "$release" -type f -links +1 -printf 'x' | wc -c)"
if [[ "$shared_release_files" -ne 0 ]]; then
  printf 'release has %s files that still share an inode with another path\n' "$shared_release_files" >&2
  exit 1
fi

delinked_recorded="$(cat "$UNIFIED_MPC_MATERIALIZE_STATE_DIR/$deployment_id/delinked_files")"
if [[ ! "$delinked_recorded" =~ ^[0-9]+$ ]]; then
  printf 'materialization state does not record a delinked file count: %s\n' "$delinked_recorded" >&2
  exit 1
fi

deployed_application="$release/apps/cli/node_modules/@unified-mpc/application/dist/index.js"
source_application="$REPO_ROOT/packages/application/dist/index.js"
test -f "$deployed_application"
test -f "$source_application"
if [[ "$(stat -c '%d:%i' -- "$deployed_application")" == "$(stat -c '%d:%i' -- "$source_application")" ]]; then
  printf 'deployed dist is the same inode as the checkout dist: %s\n' "$deployed_application" >&2
  exit 1
fi
if [[ "$(stat -c '%h' -- "$deployed_application")" -ne 1 ]]; then
  printf 'deployed dist still has %s paths\n' "$(stat -c '%h' -- "$deployed_application")" >&2
  exit 1
fi

bash "$SCRIPT_DIR/validate-runtime-root.sh" mcp-http "$release" >/dev/null
bash "$SCRIPT_DIR/validate-runtime-root.sh" web "$release" >/dev/null

# #297 S2b: the approved publish path installs exactly one host-owned helper at
# <deployment>/publish-credential-helper, emitted from the promoted artifact.
helper="$release/publish-credential-helper"
test -f "$helper"
test -x "$helper"
[[ "$(stat -c '%a' "$helper")" == "555" ]]
test -f "$release/apps/cli/dist/bin/publish-credential-helper.js"
grep -Fq 'apps/cli/dist/bin/publish-credential-helper.js' "$helper"

# The launcher runs the promoted entry, and an unconditional invocation with no
# lease answers nothing at all: exit 1, empty stdout, empty stderr.
set +e
helper_stdout="$("$helper" store </dev/null 2>"$TMP_ROOT/helper.err")"
helper_status=$?
set -e
[[ "$helper_status" -eq 1 ]]
[[ -z "$helper_stdout" ]]
[[ ! -s "$TMP_ROOT/helper.err" ]]

release_commit="$(node --input-type=commonjs -e '
  const fs = require("fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(value.buildCommit);
' "$release/runtime-release.json")"
[[ "$release_commit" == "$commit" ]]

mkdir -p "$hidden_root"
# Set the flag before the first move so a signal between the two moves still
# restores the directory that already moved.
source_hidden=true
mv -- "$REPO_ROOT/apps" "$hidden_root/apps"
mv -- "$REPO_ROOT/packages" "$hidden_root/packages"

node "$SCRIPT_DIR/smoke-materialized-runtime.mjs" "$release"

restore_hidden_source

[[ -z "$(git -C "$REPO_ROOT" status --porcelain)" ]]
printf 'runtime release portability regression: passed\n'
