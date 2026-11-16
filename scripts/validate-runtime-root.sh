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
# The live outage this guards was worse than a relative import: the release
# carried a pnpm store copy of `@unified-mpc/mcp-server` whose own module
# imports `mutation-subject.js`, which the store copy did not contain. A textual
# relative scan never sees through node_modules, so workspace specifiers are
# resolved the way the ESM loader would and their targets join the closure.
#
# ponytail: textual specifier scan, no comment/string stripping, so an
# import-shaped comment or string in dist would be read as a dependency and
# fail closed. Swap in a parser (es-module-lexer) only if dist ever embeds
# import-shaped prose; today it does not. Literal exports entries only, no
# wildcard patterns; widen if a workspace package starts exporting those.
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
const workspace = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)[\x27"](@unified-mpc\/[^\x27"]*)[\x27"]/g;

function insideRoot(file) {
  const rel = path.relative(root, file);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function firstExisting(candidates) {
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function exportTarget(entry) {
  if (typeof entry === "string") return entry;
  if (entry === null || typeof entry !== "object") return undefined;
  return exportTarget(entry.import) ?? exportTarget(entry.default) ?? exportTarget(entry.development) ?? exportTarget(entry.node);
}

function resolvePackageTarget(packageDir, subpath) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (subpath.length > 0) {
    // A workspace package can export a subpath whose target is not the literal
    // path (`@unified-mpc/shared/date-time-display`), so follow its exports map
    // before falling back to the file, which would refuse a carried file. A
    // package that does declare exports refuses an undeclared subpath, so the
    // fallback only applies to a package without an exports map.
    const exported = exportTarget(manifest.exports?.["./" + subpath]);
    if (typeof exported === "string") return path.resolve(packageDir, exported);
    if (manifest.exports !== undefined) return undefined;
    return firstExisting([
      path.join(packageDir, subpath),
      path.join(packageDir, subpath + ".js"),
      path.join(packageDir, subpath, "index.js"),
    ]);
  }
  const target = exportTarget(manifest.exports?.["."]) ?? manifest.main;
  if (typeof target !== "string") return undefined;
  return path.resolve(packageDir, target);
}

// Mirrors the node_modules walk the loader performs, bounded to the release so a
// workspace package missing from it is reported instead of silently skipped.
function resolveWorkspaceSpecifier(fromFile, specifier) {
  const segments = specifier.split("/");
  const packagePath = segments.slice(0, 2);
  const subpath = segments.slice(2).join("/");
  let candidateDir;
  try {
    // The loader resolves through package symlinks before walking node_modules,
    // so a pnpm store copy must be walked from its realpath, not the link site.
    candidateDir = path.dirname(fs.realpathSync(fromFile));
  } catch {
    candidateDir = path.dirname(fromFile);
  }
  for (;;) {
    if (!insideRoot(candidateDir) && candidateDir !== root) return undefined;
    const packageDir = path.join(candidateDir, "node_modules", ...packagePath);
    if (fs.existsSync(path.join(packageDir, "package.json"))) {
      // The gate answers "does this release carry what it imports", so a package
      // that is a symlink out of the release must be refused, not followed: the
      // materialized tree keeps `node_modules/.pnpm/node_modules/@unified-mpc/cli`
      // pointing into the source checkout until after this check.
      if (!insideRoot(fs.realpathSync(packageDir))) return undefined;
      return resolvePackageTarget(packageDir, subpath);
    }
    if (candidateDir === root) return undefined;
    const parent = path.dirname(candidateDir);
    if (parent === candidateDir) return undefined;
    candidateDir = parent;
  }
}

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
  for (const match of source.matchAll(workspace)) {
    const resolved = resolveWorkspaceSpecifier(file, match[1]);
    if (resolved === undefined) {
      missing.add(`${match[1]} (not resolvable from ${path.relative(root, file)})`);
      continue;
    }
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
