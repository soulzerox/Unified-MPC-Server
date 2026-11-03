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
    const blockedHomeFile = path.join(home, '.claude', 'CLAUDE.md');
    // A directory where a file is expected makes the read fail for this target only.
    await mkdir(blockedHomeFile, { recursive: true });
    const agentsFile = path.join(workspace, 'AGENTS.md');
    await writeFile(agentsFile, `${STALE_BLOCK}\n`, 'utf8');

    const result = await service(home, workspace).repairManagedBlocks();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);

    expect(result.value.updated).toContain(agentsFile);
    expect(result.value.failed.map((entry) => entry.file)).toContain(blockedHomeFile);
    expect(await readFile(agentsFile, 'utf8')).toContain('memory:workspace-selective');
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
