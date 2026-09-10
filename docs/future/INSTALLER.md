> **Future — not in v0.1.** The Installer runs arbitrary build scripts on untrusted sources. Deferred per ADR 0001/0003 until a sandbox proof (scripts never execute at install) and tarball provenance policy exist. Required seam: IngestionSource (future-defined). Primary source preserved below. Status: docs/FUTURE.md entry 2.

# Installer — GitHub Resolver & Build Pipeline

## Resolve

Parse any of these GitHub URL formats into a `ResolvedTarget`:

| URL format | Example |
|---|---|
| Full repo | `https://github.com/owner/repo` |
| Repo with branch | `https://github.com/owner/repo/tree/main` |
| Subfolder | `https://github.com/owner/repo/tree/main/src/some-server` |

**ResolvedTarget**:
```typescript
interface ResolvedTarget {
  owner: string;
  repo: string;
  branch: string;     // default: repo's default branch (query GitHub API)
  subpath: string;    // default: "" (root)
  tarballUrl: string; // https://api.github.com/repos/:owner/:repo/tarball/:branch
}
```

## Download

Use the GitHub tarball API. Extract only the files under `subpath` (the tarball root is `<owner>-<repo>-<shortsha>/`; strip that prefix, then filter to `subpath`).

Store the extracted files in a temporary directory first. Only move to `data/servers/<id>/` or `data/skills/<id>/` after validation passes.

Record the commit SHA (from the tarball directory name or the API response header `X-GitHub-Request-Id`) and the `ETag` response header for future lifecycle checks.

## Validate

### Skill validation

The extracted directory must contain a file named `SKILL.md` at its root. That file must have YAML frontmatter with at least a `name` field.

Reject with error:
- `SKILL_MD_MISSING` — no `SKILL.md` found.
- `FRONTMATTER_INVALID` — `SKILL.md` exists but has no parseable frontmatter or is missing `name`.

### Server validation

The extracted directory must contain one of:
- `package.json` (Node.js / TypeScript server)
- `pyproject.toml` (Python server)

Reject with error:
- `NO_MANIFEST` — neither file found.

## Build

### Node.js server

1. Run `pnpm install --frozen-lockfile`. If no `pnpm-lock.yaml`, fall back to `pnpm install`.
2. If `package.json` has a `build` script, run `pnpm run build`.
3. Detect entry point:
   - If `package.json` has `bin` → use the first binary path.
   - Else if `main` → use that path.
   - Else → use `dist/index.js` as convention, fail if it does not exist.
4. The resolved command is `node` with args `[entryPoint]` and cwd `data/servers/<id>/`.

### Python server

1. Run `uv sync` (creates `.venv` and installs dependencies).
2. Detect entry point from `[project.scripts]` in `pyproject.toml` → use the first script name.
3. The resolved command is `uv` with args `["run", scriptName]` and cwd `data/servers/<id>/`.

## Error handling

Every stage (resolve, download, validate, build) can fail. On failure:
- Clean up the temporary directory.
- Return a structured error with stage name, error code, and stderr output.
- Emit a WebSocket event `INSTALL_FAILED` with the error details.

On success:
- Move files from temp to `data/`.
- Write the `ServerConfig` or skill entry to the appropriate config file.
- Call mount or register.
- Emit a WebSocket event `INSTALL_COMPLETE`.

