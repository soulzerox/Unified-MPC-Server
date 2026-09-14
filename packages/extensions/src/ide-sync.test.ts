import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICIES, IdeSyncService } from './ide-sync.js';
import { configuredPolicies } from './runtime-policy.js';
import { DEFAULT_EXTENSIONS_SETTINGS } from './types.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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
    expect(compiled).toContain('| P2 | child:memory | memory |');
    expect(compiled).toContain('| P3 | pre-edit:thai-rag | thai-rag-mcp |');
    expect(compiled).toContain('| P4 | code-safety:godkiller | godkiller | server | ON_DEMAND | Optional |');
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
  });

  it('derives P1-Pn from the user-selected array order instead of renaming policy ids', () => {
    const service = new IdeSyncService({ policies: [DEFAULT_POLICIES[1]!, DEFAULT_POLICIES[0]!] });
    const compiled = service.compile();

    expect(compiled).toContain('| P1 | child:memory | memory |');
    expect(compiled).toContain('| P2 | session-start:ask-matt | ask-matt |');
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
    expect(cursorContent).toContain('| P2 | child:memory | memory |');

    // 2. Cline: .clinerules
    const clineFile = path.join(workspace, '.clinerules');
    const clineContent = await readFile(clineFile, 'utf8');
    expect(clineContent).toContain('# Existing Cline Rules');
    expect(clineContent).toContain('Do not delete this.');
    expect(clineContent).toContain('<!-- MCP-POLICY-START -->');
    expect(clineContent).toContain('| P2 | child:memory | memory |');
    expect(clineContent).toContain('<!-- MCP-POLICY-END -->');

    // 3. Antigravity: ~/.gemini/antigravity/rules/mcp-policy.md & workspace GEMINI.md
    const agGlobalFile = path.join(home, '.gemini', 'antigravity', 'rules', 'mcp-policy.md');
    const agGlobalContent = await readFile(agGlobalFile, 'utf8');
    expect(agGlobalContent).toContain('| P2 | child:memory | memory |');

    const agWsFile = path.join(workspace, 'GEMINI.md');
    const agWsContent = await readFile(agWsFile, 'utf8');
    expect(agWsContent).toContain('| P2 | child:memory | memory |');

    // 4. OpenCode & Freebuff: AGENTS.md
    const agentsFile = path.join(workspace, 'AGENTS.md');
    const agentsContent = await readFile(agentsFile, 'utf8');
    expect(agentsContent).toContain('# Existing Agent Instructions');
    expect(agentsContent).toContain('Preserve this note.');
    expect(agentsContent).toContain('<!-- MCP-POLICY-START -->');
    expect(agentsContent).toContain('| P2 | child:memory | memory |');
    expect(agentsContent).toContain('<!-- MCP-POLICY-END -->');

    // 5. Claude: ~/.claude/CLAUDE.md & workspace CLAUDE.md
    const claudeGlobalFile = path.join(home, '.claude', 'CLAUDE.md');
    const claudeGlobalContent = await readFile(claudeGlobalFile, 'utf8');
    expect(claudeGlobalContent).toContain('| P2 | child:memory | memory |');

    const claudeWsFile = path.join(workspace, 'CLAUDE.md');
    const claudeWsContent = await readFile(claudeWsFile, 'utf8');
    expect(claudeWsContent).toContain('| P2 | child:memory | memory |');

    // 6. Oh My Pi: workspace .omp/system.md
    const ompWsFile = path.join(workspace, '.omp', 'system.md');
    const ompWsContent = await readFile(ompWsFile, 'utf8');
    expect(ompWsContent).toContain('| P2 | child:memory | memory |');
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

