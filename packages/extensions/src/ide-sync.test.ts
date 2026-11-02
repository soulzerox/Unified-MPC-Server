import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICIES, IdeSyncService, resolveCodexHome, type SyncTarget } from './ide-sync.js';
import { configuredPolicies } from './runtime-policy.js';
import { SkillCatalog } from './skill-catalog.js';
import { DEFAULT_EXTENSIONS_SETTINGS } from './types.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Run `body` with environment overrides applied, restoring them afterwards. A `undefined` value unsets the key. */
async function withEnv<T>(overrides: Readonly<Record<string, string | undefined>>, body: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await body();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('resolveCodexHome', () => {
  const home = path.join(path.sep, 'tmp', 'codex-home-resolution', 'home');

  it('falls back to <home>/.codex when CODEX_HOME is unset, empty or blank', async () => {
    const expected = path.join(home, '.codex');
    // All three states mean "not configured", so every one of them must land on
    // the documented default instead of producing an empty or cwd-relative root.
    for (const configured of [undefined, '', '   ']) {
      await withEnv({ CODEX_HOME: configured }, async () => {
        expect(resolveCodexHome(home, undefined)).toBe(expected);
      });
    }
  });

  it('resolves a relative CODEX_HOME against the working directory instead of dropping it', async () => {
    await withEnv({ CODEX_HOME: 'relative-codex-home' }, async () => {
      expect(resolveCodexHome(home, undefined)).toBe(path.resolve('relative-codex-home'));
    });
  });

  it('ignores the ambient CODEX_HOME when the caller pins a home directory', async () => {
    // Callers pass the pinned home as both arguments, so the second parameter
    // acts as the "do not read the environment" signal.
    const pinned = path.join(path.sep, 'tmp', 'codex-home-resolution', 'pinned');
    await withEnv({ CODEX_HOME: path.join(path.sep, 'tmp', 'ambient-codex-home') }, async () => {
      expect(resolveCodexHome(pinned, pinned)).toBe(path.join(pinned, '.codex'));
    });
  });

  it('applies the same resolution in SkillCatalog, whose copy cannot call this helper', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-home-parity-'));
    temporaryRoots.push(root);
    const isolatedHome = path.join(root, 'isolated-home');
    const codexHome = path.join(root, 'custom-codex-home');
    const skillDir = path.join(codexHome, 'skills', 'parity-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: parity-skill\ndescription: Parity skill\n---\n# Parity\n',
      'utf8',
    );

    await withEnv({ CODEX_HOME: codexHome, HOME: isolatedHome }, async () => {
      // No pinned homeDir, so the catalog exercises its inline copy of the
      // resolution against the ambient variable.
      const catalog = new SkillCatalog({ settings: DEFAULT_EXTENSIONS_SETTINGS });
      const listed = await catalog.list({ query: 'parity' });

      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      const skill = listed.value.skills.find((entry) => entry.name === 'parity-skill');
      expect(skill?.id).toBe('codex-skills/parity-skill');
      expect(skill?.rootPath).toBe(path.join(resolveCodexHome(os.homedir(), undefined), 'skills'));
    });
  });
});

describe('IdeSyncService', () => {
  it('classifies vetted optional child inspection tools as read-only without including mutations', () => {
    const context7 = DEFAULT_POLICIES.find((policy) => policy.id === 'optional:context7');
    const filesystem = DEFAULT_POLICIES.find((policy) => policy.id === 'optional:filesystem');

    expect(context7?.readOnlyTools).toEqual(['resolve-library-id', 'query-docs']);
    expect(filesystem?.readOnlyTools).toEqual([
      'read_file',
      'read_text_file',
      'read_media_file',
      'read_multiple_files',
      'list_directory',
      'list_directory_with_sizes',
      'directory_tree',
      'search_files',
      'get_file_info',
      'list_allowed_directories',
    ]);
    expect(filesystem?.readOnlyTools).not.toEqual(expect.arrayContaining(['write_file', 'edit_file', 'create_directory', 'move_file']));
  });

  it('compiles editable P1-Pn positions while keeping semantic policy ids stable', () => {
    const service = new IdeSyncService({});
    const compiled = service.compile();

    expect(compiled).toContain('<!-- MCP-POLICY-START -->');
    expect(compiled).toContain('<!-- MCP-POLICY-END -->');
    expect(compiled).toContain('| P1 | session-start:ask-matt | ask-matt |');
    expect(compiled).toContain('| P2 | memory:workspace-selective | native-memory | capability | ON_DEMAND | Optional |');
    expect(compiled).toContain('| P3 | code:pre-edit-context | native-thai-rag | capability | SAFETY_PRE_CHECK | ✅ YES |');
    expect(compiled).toContain('| P4 | code-safety:godkiller | godkiller | server | ON_DEMAND | Optional |');
    expect(compiled).not.toContain('pre-edit:thai-rag');
    expect(DEFAULT_POLICIES.find((policy) => policy.id === 'code-safety:godkiller')).toMatchObject({
      mandatory: false,
      enforcement: 'ON_DEMAND',
      requiredTools: ['gk_task'],
    });
  });

  it('does not let the legacy mandatory server list override an explicit optional Godkiller policy', () => {
    const policies = configuredPolicies({
      ...DEFAULT_EXTENSIONS_SETTINGS,
      mandatoryMcpServers: ['memory', 'thai-rag-mcp', 'godkiller'],
    });
    const godkillerPolicies = policies.filter((policy) => policy.resourceId === 'godkiller');

    expect(godkillerPolicies).toEqual([
      expect.objectContaining({ id: 'code-safety:godkiller', mandatory: false, enforcement: 'ON_DEMAND' }),
    ]);
    expect(policies.some((policy) => policy.resourceId === 'thai-rag-mcp')).toBe(false);
  });

  it('derives P1-Pn from the user-selected array order instead of renaming policy ids', () => {
    const service = new IdeSyncService({ policies: [DEFAULT_POLICIES[1]!, DEFAULT_POLICIES[0]!] });
    const compiled = service.compile();

    expect(compiled).toContain('| P1 | memory:workspace-selective | native-memory | capability | ON_DEMAND | Optional |');
    expect(compiled).toContain('| P2 | session-start:ask-matt | ask-matt |');
  });

  it('rejects an unknown sync target instead of reporting a silent no-op', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-ide-sync-'));
    temporaryRoots.push(root);
    const service = new IdeSyncService({
      homeDir: path.join(root, 'home'),
      workspaceRoot: path.join(root, 'workspace'),
    });

    // The CLI casts `--targets` values into the closed SyncTarget union, so a
    // typo reaches the service as an unknown name. Reporting success with zero
    // files would leave the user believing the policy had been synced.
    const result = await service.sync(['curser' as SyncTarget]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('UNSUPPORTED_TARGET');
    expect(result.error.message).toBe(
      'Unsupported target(s): curser. Supported targets: all, cursor, cline, claude, antigravity, opencode, codex, omp, agents',
    );
  });

  it('rejects an empty sync target list instead of reporting a silent no-op', async () => {
    const service = new IdeSyncService({});

    const result = await service.sync([]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toBe('At least one target must be specified');
  });

  it('synchronizes the documented codex target into the Codex home and the workspace AGENTS.md', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-ide-sync-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    const decoyCodexHome = path.join(root, 'decoy-codex-home');
    // A pinned home is authoritative: an ambient CODEX_HOME must not redirect it.
    await withEnv({ CODEX_HOME: decoyCodexHome }, async () => {
      const service = new IdeSyncService({ homeDir: home, workspaceRoot: workspace });

      const result = await service.sync(['codex']);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Codex reads `$CODEX_HOME/AGENTS.md` globally and `<repo>/AGENTS.md` per project.
      expect(await readFile(path.join(home, '.codex', 'AGENTS.md'), 'utf8')).toContain('<!-- MCP-POLICY-START -->');
      expect(await readFile(path.join(workspace, 'AGENTS.md'), 'utf8')).toContain('<!-- MCP-POLICY-START -->');
      expect(result.value.updatedFiles).toEqual([
        path.join(workspace, 'AGENTS.md'),
        path.join(home, '.codex', 'AGENTS.md'),
      ]);
      // The OpenCode global file belongs to the opencode target, not to codex.
      await expect(readFile(path.join(home, '.config', 'opencode', 'AGENTS.md'), 'utf8')).rejects.toThrow();
      await expect(readFile(path.join(decoyCodexHome, 'AGENTS.md'), 'utf8')).rejects.toThrow();
    });
  });

  it('honors CODEX_HOME for the codex target when no home directory is pinned', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-ide-sync-'));
    temporaryRoots.push(root);
    const codexHome = path.join(root, 'custom-codex-home');
    const workspace = path.join(root, 'workspace');
    // HOME is isolated too: if CODEX_HOME resolution regresses, the fallback must
    // land in a temporary directory rather than the developer's real ~/.codex.
    const isolatedHome = path.join(root, 'isolated-home');

    await withEnv({ CODEX_HOME: codexHome, HOME: isolatedHome }, async () => {
      const service = new IdeSyncService({ workspaceRoot: workspace });

      const result = await service.sync(['codex']);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.updatedFiles).toContain(path.join(codexHome, 'AGENTS.md'));
      expect(await readFile(path.join(codexHome, 'AGENTS.md'), 'utf8')).toContain('<!-- MCP-POLICY-START -->');
      await expect(readFile(path.join(isolatedHome, '.codex', 'AGENTS.md'), 'utf8')).rejects.toThrow();
    });
  });

  it('writes the OpenCode global AGENTS.md for the opencode target alone', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-ide-sync-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    const service = new IdeSyncService({ homeDir: home, workspaceRoot: workspace });

    // `all` short-circuits every predicate, so only a specific target proves the
    // opencode/agents branch of the AGENTS.md split.
    const result = await service.sync(['opencode']);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.updatedFiles).toEqual([
      path.join(workspace, 'AGENTS.md'),
      path.join(home, '.config', 'opencode', 'AGENTS.md'),
    ]);
    expect(await readFile(path.join(home, '.config', 'opencode', 'AGENTS.md'), 'utf8')).toContain('<!-- MCP-POLICY-START -->');
    await expect(readFile(path.join(home, '.codex', 'AGENTS.md'), 'utf8')).rejects.toThrow();
  });

  it('atomically synchronizes policies across all universal clients', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-ide-sync-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');

    // Pre-create existing files with custom content to test block replacement
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, '.clinerules'), '# Existing Cline Rules\nDo not delete this.\n', 'utf8');
    await writeFile(path.join(workspace, 'AGENTS.md'), '# Existing Agent Instructions\nPreserve this note.\n', 'utf8');

    const service = new IdeSyncService({
      homeDir: home,
      workspaceRoot: workspace,
    });

    const result = await service.sync(['all']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 1. Cursor: .cursor/rules/00-mandatory-policy.mdc
    const cursorFile = path.join(workspace, '.cursor', 'rules', '00-mandatory-policy.mdc');
    const cursorContent = await readFile(cursorFile, 'utf8');
    expect(cursorContent).toContain('alwaysApply: true');
    expect(cursorContent).toContain('| P2 | memory:workspace-selective | native-memory | capability | ON_DEMAND | Optional |');

    // 2. Cline: .clinerules
    const clineFile = path.join(workspace, '.clinerules');
    const clineContent = await readFile(clineFile, 'utf8');
    expect(clineContent).toContain('# Existing Cline Rules');
    expect(clineContent).toContain('Do not delete this.');
    expect(clineContent).toContain('<!-- MCP-POLICY-START -->');
    expect(clineContent).toContain('| P2 | memory:workspace-selective | native-memory | capability | ON_DEMAND | Optional |');
    expect(clineContent).toContain('<!-- MCP-POLICY-END -->');

    // 3. Antigravity: ~/.gemini/antigravity/rules/mcp-policy.md & workspace GEMINI.md
    const agGlobalFile = path.join(home, '.gemini', 'antigravity', 'rules', 'mcp-policy.md');
    const agGlobalContent = await readFile(agGlobalFile, 'utf8');
    expect(agGlobalContent).toContain('| P2 | memory:workspace-selective | native-memory | capability | ON_DEMAND | Optional |');

    const agWsFile = path.join(workspace, 'GEMINI.md');
    const agWsContent = await readFile(agWsFile, 'utf8');
    expect(agWsContent).toContain('| P2 | memory:workspace-selective | native-memory | capability | ON_DEMAND | Optional |');

    // 4. OpenCode & Freebuff: AGENTS.md
    const agentsFile = path.join(workspace, 'AGENTS.md');
    const agentsContent = await readFile(agentsFile, 'utf8');
    expect(agentsContent).toContain('# Existing Agent Instructions');
    expect(agentsContent).toContain('Preserve this note.');
    expect(agentsContent).toContain('<!-- MCP-POLICY-START -->');
    expect(agentsContent).toContain('| P2 | memory:workspace-selective | native-memory | capability | ON_DEMAND | Optional |');
    expect(agentsContent).toContain('<!-- MCP-POLICY-END -->');

    // The OpenCode global file is also written by `all`; the dedicated
    // `sync(['opencode'])` test is what actually guards that branch predicate.
    const opencodeGlobalFile = path.join(home, '.config', 'opencode', 'AGENTS.md');
    const opencodeGlobalContent = await readFile(opencodeGlobalFile, 'utf8');
    expect(opencodeGlobalContent).toContain('| P2 | memory:workspace-selective | native-memory | capability | ON_DEMAND | Optional |');

    // 5. Claude: ~/.claude/CLAUDE.md & workspace CLAUDE.md
    const claudeGlobalFile = path.join(home, '.claude', 'CLAUDE.md');
    const claudeGlobalContent = await readFile(claudeGlobalFile, 'utf8');
    expect(claudeGlobalContent).toContain('| P2 | memory:workspace-selective | native-memory | capability | ON_DEMAND | Optional |');

    const claudeWsFile = path.join(workspace, 'CLAUDE.md');
    const claudeWsContent = await readFile(claudeWsFile, 'utf8');
    expect(claudeWsContent).toContain('| P2 | memory:workspace-selective | native-memory | capability | ON_DEMAND | Optional |');

    // 6. Oh My Pi: workspace .omp/system.md
    const ompWsFile = path.join(workspace, '.omp', 'system.md');
    const ompWsContent = await readFile(ompWsFile, 'utf8');
    expect(ompWsContent).toContain('| P2 | memory:workspace-selective | native-memory | capability | ON_DEMAND | Optional |');

    // 7. Codex: ~/.codex/AGENTS.md
    const codexGlobalFile = path.join(home, '.codex', 'AGENTS.md');
    const codexGlobalContent = await readFile(codexGlobalFile, 'utf8');
    expect(codexGlobalContent).toContain('| P2 | memory:workspace-selective | native-memory | capability | ON_DEMAND | Optional |');
  });

  it('updates policy block idempotently without duplicating content', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-ide-sync-idempotent-'));
    temporaryRoots.push(root);
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace, { recursive: true });

    const service = new IdeSyncService({ workspaceRoot: workspace });

    // First sync
    await service.sync(['cline']);
    const firstContent = await readFile(path.join(workspace, '.clinerules'), 'utf8');
    expect(firstContent).toContain('<!-- MCP-POLICY-START -->');

    // Second sync with custom policy
    const customService = new IdeSyncService({
      workspaceRoot: workspace,
      policies: [
        ...DEFAULT_POLICIES,
        {
          id: 'custom:tool',
          resourceId: 'custom-tool',
          resourceType: 'server',
          mandatory: false,
          enforcement: 'ON_DEMAND',
          directive: 'Custom tool directive',
        },
      ],
    });
    await customService.sync(['cline']);
    const secondContent = await readFile(path.join(workspace, '.clinerules'), 'utf8');

    // Check that markers occur exactly once
    const startCount = (secondContent.match(/<!-- MCP-POLICY-START -->/g) || []).length;
    const endCount = (secondContent.match(/<!-- MCP-POLICY-END -->/g) || []).length;
    expect(startCount).toBe(1);
    expect(endCount).toBe(1);
    expect(secondContent).toContain('custom-tool');
  });
});
