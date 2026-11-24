#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
TMP_ROOT=""
source_snapshot=""

restore_source() {
  if [[ -n "$source_snapshot" ]]; then
    remove_snapshot_worktree
  fi
  if [[ -n "$TMP_ROOT" ]]; then
    rm -rf -- "$TMP_ROOT"
  fi
}
# A killed materializer can leave its snapshot worktree locked, and a failed
# `worktree remove` would otherwise leave `$GIT_COMMON_DIR/worktrees/source*`
# pointing at a path this run deletes — a registration every later gate run has
# to carry. Force past the lock and prune whatever the removal left behind.
remove_snapshot_worktree() {
  git -C "$REPO_ROOT" worktree remove --force --force "$source_snapshot" >/dev/null 2>&1 ||
    rm -rf -- "$source_snapshot"
  git -C "$REPO_ROOT" worktree prune >/dev/null 2>&1 || true
}
# Installed before the temp root is chosen: choosing it can refuse, and a
# refusal must not leave a directory behind. The traps only remove this run's
# own temp root; the checkout is never mutated (#967).
trap restore_source EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

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
export UNIFIED_MPC_RUNTIME_DIR="$TMP_ROOT/runtime"
export UNIFIED_MPC_MATERIALIZE_STATE_DIR="$TMP_ROOT/materializations"
export UNIFIED_MPC_VALIDATE_RUNTIME_ROOT="$SCRIPT_DIR/validate-runtime-root.sh"

commit="$(git -C "$REPO_ROOT" rev-parse --verify HEAD)"
deployment_id="portable-${commit:0:12}"

# #967: materialize from a throwaway source instead of hiding the live
# `apps/` and `packages/`. The regression is the same — the release must keep
# working after its source is gone — but the deletion lands on a copy, so a
# concurrent build or `verify:local` in this checkout is no longer broken and a
# killed run cannot leave the checkout gutted.
#
# A plain copy cannot stand in for the source: the materializer requires its
# source root to be a Git worktree root, and a copied `.git` file still resolves
# to the original worktree. A detached linked worktree satisfies that rule
# without registering anything new in the caller's checkout.
source_snapshot="$TMP_ROOT/source"
git -C "$REPO_ROOT" worktree add --detach --quiet "$source_snapshot" "$commit"
# The materializer records `source_path` after `readlink -f`, so canonicalize
# here: a symlinked component of `$TMP_ROOT` would otherwise fail the state
# assertion below after a fully successful materialization.
source_snapshot="$(readlink -f -- "$source_snapshot")"
# The worktree has tracked files only; the build outputs and dependency trees
# it needs are ignored paths, so copy those across.
while IFS= read -r -d '' ignored; do
  case "$ignored" in
    .unified-mpc|.unified-mpc/) continue ;;
  esac
  mkdir -p -- "$(dirname -- "$source_snapshot/$ignored")"
  cp -a --reflink=auto -- "$REPO_ROOT/$ignored" "$source_snapshot/$ignored"
done < <(git -C "$REPO_ROOT" ls-files -o -i --exclude-standard --directory -z)

bash "$SCRIPT_DIR/materialize-runtime-release.sh" "$deployment_id" "$source_snapshot" >"$TMP_ROOT/materialize.log"
release="$UNIFIED_MPC_RUNTIME_DIR/releases/$deployment_id"

grep -Fxq published "$UNIFIED_MPC_MATERIALIZE_STATE_DIR/$deployment_id/status"
grep -Fxq "$source_snapshot" "$UNIFIED_MPC_MATERIALIZE_STATE_DIR/$deployment_id/source_path"
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

# The source is gone before the release is exercised: this is the part the old
# `mv` dance proved, now done without touching the checkout.
remove_snapshot_worktree
[[ ! -d "$source_snapshot" ]]
# And the registration must not outlive the run: a leftover one points at a
# deleted path in the gitdir this checkout shares with every goal worktree, so
# each later gate run carries it (#969). Match on this run's own path rather
# than on the admin name, so a concurrent worktree of the same clone is not
# mistaken for a leak.
[[ -z "$(git -C "$REPO_ROOT" worktree list --porcelain | grep -F -- "$source_snapshot" || true)" ]]

node "$SCRIPT_DIR/smoke-materialized-runtime.mjs" "$release"

[[ -z "$(git -C "$REPO_ROOT" status --porcelain)" ]]
printf 'runtime release portability regression: passed\n'
