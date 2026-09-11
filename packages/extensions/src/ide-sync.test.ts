import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICIES, IdeSyncService } from './ide-sync.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('IdeSyncService', () => {
  it('compiles default P1-P7 policy markdown with markers and execution table', () => {
    const service = new IdeSyncService({});
    const compiled = service.compile();

    expect(compiled).toContain('<!-- MCP-POLICY-START -->');
    expect(compiled).toContain('<!-- MCP-POLICY-END -->');
    expect(compiled).toContain('| P1 | memory |');
    expect(compiled).toContain('| P2 | thai-rag-mcp |');
    expect(compiled).toContain('| P3 | godkiller |');
    expect(compiled).toContain('| P4 | sequentialthinking |');
    expect(compiled).toContain('| P5 | context7 |');
    expect(compiled).toContain('| P6 | filesystem |');
    expect(compiled).toContain('| P7 | ui-skills |');
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
    expect(cursorContent).toContain('| P1 | memory |');

    // 2. Cline: .clinerules
    const clineFile = path.join(workspace, '.clinerules');
    const clineContent = await readFile(clineFile, 'utf8');
    expect(clineContent).toContain('# Existing Cline Rules');
    expect(clineContent).toContain('Do not delete this.');
    expect(clineContent).toContain('<!-- MCP-POLICY-START -->');
    expect(clineContent).toContain('| P1 | memory |');
    expect(clineContent).toContain('<!-- MCP-POLICY-END -->');

    // 3. Antigravity: ~/.gemini/antigravity/rules/mcp-policy.md & workspace GEMINI.md
    const agGlobalFile = path.join(home, '.gemini', 'antigravity', 'rules', 'mcp-policy.md');
    const agGlobalContent = await readFile(agGlobalFile, 'utf8');
    expect(agGlobalContent).toContain('| P1 | memory |');

    const agWsFile = path.join(workspace, 'GEMINI.md');
    const agWsContent = await readFile(agWsFile, 'utf8');
    expect(agWsContent).toContain('| P1 | memory |');

    // 4. OpenCode & Freebuff: AGENTS.md
    const agentsFile = path.join(workspace, 'AGENTS.md');
    const agentsContent = await readFile(agentsFile, 'utf8');
    expect(agentsContent).toContain('# Existing Agent Instructions');
    expect(agentsContent).toContain('Preserve this note.');
    expect(agentsContent).toContain('<!-- MCP-POLICY-START -->');
    expect(agentsContent).toContain('| P1 | memory |');
    expect(agentsContent).toContain('<!-- MCP-POLICY-END -->');

    // 5. Claude: ~/.claude/CLAUDE.md & workspace CLAUDE.md
    const claudeGlobalFile = path.join(home, '.claude', 'CLAUDE.md');
    const claudeGlobalContent = await readFile(claudeGlobalFile, 'utf8');
    expect(claudeGlobalContent).toContain('| P1 | memory |');

    const claudeWsFile = path.join(workspace, 'CLAUDE.md');
    const claudeWsContent = await readFile(claudeWsFile, 'utf8');
    expect(claudeWsContent).toContain('| P1 | memory |');

    // 6. Oh My Pi: workspace .omp/system.md
    const ompWsFile = path.join(workspace, '.omp', 'system.md');
    const ompWsContent = await readFile(ompWsFile, 'utf8');
    expect(ompWsContent).toContain('| P1 | memory |');
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

    // Second sync with custom policy
    const customService = new IdeSyncService({
      workspaceRoot: workspace,
      policies: [
        ...DEFAULT_POLICIES,
        {
          priority: 'P7',
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

