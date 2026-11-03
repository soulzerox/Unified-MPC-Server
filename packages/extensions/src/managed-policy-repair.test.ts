import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IdeSyncService, POLICY_BLOCK_END, POLICY_BLOCK_START } from './ide-sync.js';
import { DEFAULT_EXTENSIONS_SETTINGS } from './types.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoots(): Promise<{ home: string; workspace: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-policy-repair-'));
  temporaryRoots.push(root);
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  return { home, workspace };
}

/** The released pre-native-capability managed block, as an upgraded install still has it on disk. */
const STALE_BLOCK = [
  POLICY_BLOCK_START,
  '# MCP Runtime Policy — Dynamic Resource Routing',
  '',
  '| Priority | Policy | Resource | Type | Enforcement | Mandatory |',
  '|---|---|---|---|---|---|',
  '| P1 | child:memory | memory | server | REALTIME | ✅ YES |',
  '| P2 | pre-edit:thai-rag | thai-rag-mcp | server | EVERY_SESSION | ✅ YES |',
  '',
  '## Enforcement Rules',
  '',
  '- **P1 · child:memory / memory** (REALTIME): Use working memory proactively.',
  '- **P2 · pre-edit:thai-rag / thai-rag-mcp** (EVERY_SESSION): Use local RAG automatically.',
  '',
  POLICY_BLOCK_END,
].join('\n');

function service(home: string, workspace?: string): IdeSyncService {
  return new IdeSyncService({
    homeDir: home,
    ...(workspace === undefined ? {} : { workspaceRoot: workspace }),
    settings: { ...DEFAULT_EXTENSIONS_SETTINGS },
  });
}

describe('IdeSyncService.repairManagedBlocks', () => {
  it('replaces a stale managed block with the current policy rows and keeps user content', async () => {
    const { home, workspace } = await makeRoots();
    const agentsFile = path.join(workspace, 'AGENTS.md');
    await writeFile(agentsFile, `# Project notes\n\nKeep this line.\n\n${STALE_BLOCK}\n\nTail content stays.\n`, 'utf8');

    const result = await service(home, workspace).repairManagedBlocks();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.updated).toContain(agentsFile);
    expect(result.value.failed).toEqual([]);

    const repaired = await readFile(agentsFile, 'utf8');
    expect(repaired).toContain('# Project notes');
    expect(repaired).toContain('Keep this line.');
    expect(repaired).toContain('Tail content stays.');
    expect(repaired).toContain('memory:workspace-selective');
    expect(repaired).toContain('code:pre-edit-context');
    expect(repaired).not.toContain('child:memory');
    expect(repaired).not.toContain('pre-edit:thai-rag');
    expect(repaired.match(new RegExp(POLICY_BLOCK_START, 'g'))).toHaveLength(1);
    expect(repaired.match(new RegExp(POLICY_BLOCK_END, 'g'))).toHaveLength(1);
  });

  it('is idempotent: a second repair reports the file as unchanged and rewrites nothing', async () => {
    const { home, workspace } = await makeRoots();
    const agentsFile = path.join(workspace, 'AGENTS.md');
    await writeFile(agentsFile, `# Project notes\n\n${STALE_BLOCK}\n`, 'utf8');

    const first = await service(home, workspace).repairManagedBlocks();
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value.updated).toContain(agentsFile);

    const afterFirst = await readFile(agentsFile, 'utf8');
    const second = await service(home, workspace).repairManagedBlocks();
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.error.message);
    expect(second.value.updated).toEqual([]);
    expect(second.value.unchanged).toContain(agentsFile);
    expect(await readFile(agentsFile, 'utf8')).toBe(afterFirst);
  });

  it('never creates a missing target and never appends a block to a file without managed markers', async () => {
    const { home, workspace } = await makeRoots();
    const claudeFile = path.join(home, '.claude', 'CLAUDE.md');
    const agentsFile = path.join(workspace, 'AGENTS.md');
    await writeFile(agentsFile, '# Only user content\n\nNo managed block here.\n', 'utf8');

    const result = await service(home, workspace).repairManagedBlocks();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);

    expect(result.value.updated).toEqual([]);
    expect(await readFile(agentsFile, 'utf8')).toBe('# Only user content\n\nNo managed block here.\n');
    await expect(readFile(claudeFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.value.skipped).toContain(agentsFile);
    expect(result.value.skipped).toContain(claudeFile);
  });

  it('reports one unreadable target without stopping the remaining repairs', async () => {
    const { home, workspace } = await makeRoots();
    // The first target in iteration order fails, so an implementation that
    // aborts on the first error cannot pass this test.
    const blockedFile = path.join(workspace, '.cursor', 'rules', '00-mandatory-policy.mdc');
    // A directory where a file is expected makes the read fail for this target only.
    await mkdir(blockedFile, { recursive: true });
    const agentsFile = path.join(workspace, 'AGENTS.md');
    await writeFile(agentsFile, `${STALE_BLOCK}\n`, 'utf8');

    const result = await service(home, workspace).repairManagedBlocks();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);

    expect(result.value.failed.map((entry) => entry.file)).toEqual([blockedFile]);
    expect(result.value.updated).toContain(agentsFile);
    expect(await readFile(agentsFile, 'utf8')).toContain('memory:workspace-selective');
  });

  it('leaves whole-file artifacts alone when their content carries no managed block', async () => {
    const { home, workspace } = await makeRoots();
    const cursorFile = path.join(workspace, '.cursor', 'rules', '00-mandatory-policy.mdc');
    const antigravityFile = path.join(home, '.gemini', 'antigravity', 'rules', 'mcp-policy.md');
    const cursorContent = '---\nalwaysApply: true\n---\n\n# My own rules\n\nKeep me.\n';
    const antigravityContent = '# Hand-written Antigravity rules\n\nKeep me too.\n';
    await mkdir(path.dirname(cursorFile), { recursive: true });
    await mkdir(path.dirname(antigravityFile), { recursive: true });
    await writeFile(cursorFile, cursorContent, 'utf8');
    await writeFile(antigravityFile, antigravityContent, 'utf8');

    const result = await service(home, workspace).repairManagedBlocks();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);

    expect(result.value.updated).toEqual([]);
    expect(result.value.skipped).toContain(cursorFile);
    expect(result.value.skipped).toContain(antigravityFile);
    expect(await readFile(cursorFile, 'utf8')).toBe(cursorContent);
    expect(await readFile(antigravityFile, 'utf8')).toBe(antigravityContent);
  });

  it('skips a half-written file that has an opening marker but no closing marker', async () => {
    const { home, workspace } = await makeRoots();
    const agentsFile = path.join(workspace, 'AGENTS.md');
    const halfWritten = `# Project notes\n\n${POLICY_BLOCK_START}\n\nMissing the closing marker.\n`;
    await writeFile(agentsFile, halfWritten, 'utf8');

    const result = await service(home, workspace).repairManagedBlocks();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);

    expect(result.value.skipped).toContain(agentsFile);
    expect(await readFile(agentsFile, 'utf8')).toBe(halfWritten);
  });

  it('skips workspace targets when no workspace root is configured', async () => {
    const { home, workspace } = await makeRoots();
    const agentsFile = path.join(workspace, 'AGENTS.md');
    await writeFile(agentsFile, `${STALE_BLOCK}\n`, 'utf8');

    const result = await service(home).repairManagedBlocks();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);

    expect(result.value.scanned).toBeGreaterThan(0);
    expect([...result.value.updated, ...result.value.skipped, ...result.value.failed.map((entry) => entry.file)])
      .not.toContain(agentsFile);
    expect(await readFile(agentsFile, 'utf8')).toContain('child:memory');
  });
});
