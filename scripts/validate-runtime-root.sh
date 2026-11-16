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

# #835: the provenance and entrypoint can both be present while the release is
# still broken — a rebuild through a shared inode rewrites `index.js` to import
# siblings that only exist in the checkout, and the failure shows up on the next
# restart as ERR_MODULE_NOT_FOUND. Resolve the relative-import closure of every
# runtime entry the release carries, so promotion refuses a release the service
# could not boot.
#
# ponytail: textual specifier scan, no comment/string stripping, so an
# import-shaped comment or string in dist would be read as a dependency and
# fail closed. Swap in a parser (es-module-lexer) only if dist ever embeds
# import-shaped prose; today it does not.
node_bin="${UNIFIED_MPC_NODE:-node}"
if ! command -v "$node_bin" >/dev/null 2>&1; then
  fail 69 "RUNTIME_ROOT_INVALID: '$node_bin' is required to check the release import closure"
fi
closure_entries=()
for candidate in \
  "apps/cli/dist/index.js" \
  "apps/cli/dist/bin/mcp-http.js" \
  "apps/cli/dist/bin/mcp-stdio.js" \
  "apps/cli/dist/bin/publish-credential-helper.js"; do
  if [[ -f "$resolved_root/$candidate" ]]; then
    closure_entries+=("$candidate")
  fi
done
closure_missing="$("$node_bin" --input-type=module -e '
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[1]);
const entries = process.argv.slice(2).map((entry) => path.resolve(root, entry));
const relative = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)[\x27"](\.[^\x27"]*)[\x27"]/g;
const seen = new Set();
const missing = new Set();
const queue = [...entries];
while (queue.length > 0) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  let source;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch (error) {
    // A missing member is the release defect; anything else (EACCES, EISDIR) is
    // a preflight failure and must not be reported as a complete release.
    if (error.code === "ENOENT") {
      missing.add(path.relative(root, file));
      continue;
    }
    process.stderr.write(`${path.relative(root, file)}: ${error.code ?? error.message}\n`);
    process.exit(2);
  }
  for (const match of source.matchAll(relative)) {
    const resolved = path.resolve(path.dirname(file), match[1]);
    if (!fs.existsSync(resolved)) {
      missing.add(`${path.relative(root, resolved)} (imported by ${path.relative(root, file)})`);
      continue;
    }
    if (/\.[cm]?js$/.test(resolved)) queue.push(resolved);
  }
}
process.stdout.write([...missing].sort().join("\n"));
' "$resolved_root" "${closure_entries[@]}")" || fail 69 "RUNTIME_ROOT_INVALID: release import closure could not be read (see stderr)"
if [[ -n "$closure_missing" ]]; then
  fail 67 "RUNTIME_ARTIFACT_INCOMPLETE: release imports files it does not contain:
$closure_missing"
fi

provenance="$resolved_root/apps/cli/dist/build-provenance.json"
if [[ ! -f "$provenance" ]]; then
  fail 67 "RUNTIME_ARTIFACT_MISSING: expected build provenance '$provenance'"
fi

printf 'RUNTIME_ROOT_OK: service=%s root=%s\n' "$service" "$resolved_root"
