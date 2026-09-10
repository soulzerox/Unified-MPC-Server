> **Future — not in v0.1.** The Pruner depends on the installer's resource lifecycle (mount/unmount of ingested resources). Deferred with the Installer per ADR 0001/0003. Primary source preserved below. Status: docs/FUTURE.md entry 3.

# Pruner — Zero-Artifact Deletion Protocol

Every prune is transactional: either everything is removed, or the operation reports what remains. Nothing silently lingers.

## Server prune sequence

Execute in this exact order. Each step depends on the previous.

1. **Unmount** — call `multiplexer.unmount(id)`. This sends SIGTERM to the child process, waits 5 seconds, then SIGKILL if still alive. Removes all namespaced routes from the tool catalog.

2. **Config removal** — delete the entry from `config/servers.json`. Write the file atomically (write to temp, rename).

3. **Directory wipe** — `fs.rm(path.join(SERVERS_DIR, id), { recursive: true, force: true })`. This removes the source code, `node_modules`, `.venv`, build output, and any other artifacts.

4. **Policy cleanup** — if `config/policies.json` contains entries referencing this server ID, mark them as `orphaned: true` (keep the entry but flag it so the UI shows a warning, rather than silently deleting the user's configured priority).

5. **Verification** — after all steps, check:
   - `fs.existsSync(path.join(SERVERS_DIR, id))` must be `false`.
   - `multiplexer.listTools()` must contain no tools with the `id__` prefix.
   - No process with the server's PID is still running (`process.kill(pid, 0)` must throw).

Report all results in `PruneReport`.

## Skill prune sequence

1. **Unregister** — call `skillRegistry.unregister(id)`. Removes from the in-memory catalog. MCP `prompts/list` and `skills__list` immediately stop returning it.

2. **Directory wipe** — `fs.rm(path.join(SKILLS_DIR, id), { recursive: true, force: true })`.

3. **IDE file pruning** — call `ideSync.pruneSkill(id)`. For each IDE target:
   - Cursor: delete `.cursor/rules/<id>.mdc`.
   - Continue: delete `~/.continue/prompts/<id>.prompt`.
   - Claude Code: delete `~/.claude/commands/<id>.md`.
   - Antigravity: remove symlink at `~/.gemini/config/skills/<id>/`.
   - Cline: remove the skill's section from `.clinerules` (regex-bounded block removal).

4. **Policy cleanup** — same as server prune: flag orphaned entries.

5. **Verification** — after all steps:
   - `fs.existsSync(path.join(SKILLS_DIR, id))` must be `false`.
   - `skillRegistry.get(id)` must throw `NOT_FOUND`.
   - None of the IDE target files for this skill exist.

Report all results in `PruneReport`. Include the list of IDE files that were successfully removed.

## Edge cases

- **Process already dead**: unmount still cleans up routes. No error.
- **Directory already missing**: `fs.rm` with `force: true` does not throw. No error.
- **IDE directory does not exist** (e.g. user does not have Cursor installed): skip that target silently. Do not create the directory.
- **File permission denied**: report in `PruneReport.errors` with the file path and error message. Continue with remaining targets — do not abort the whole prune.

