import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitStatusResult } from '@unified-mpc/git';
import { sealMixedDirtyGoalWorkspace, type GoalWorkspaceRetentionGitPort, type SealMixedDirtyGoalWorkspaceRequest } from './goal-workspace-retention-service.js';

const HEAD = 'a'.repeat(40);
const TRACKED = '.github/workflows/runtime-release-portability.yml';
const UNTRACKED = 'scripts/gateway-persistence-restart.test.mjs';

const dirtyEntries: GitStatusResult['entries'] = [
  { path: TRACKED, kind: 'modified', indexStatus: ' ', worktreeStatus: 'M' },
  { path: UNTRACKED, kind: 'untracked', indexStatus: '?', worktreeStatus: '?' },
];

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

async function harness(): Promise<{
  root: string;
  sourceRoot: string;
  retentionRoot: string;
  request: SealMixedDirtyGoalWorkspaceRequest;
  statusCalls: () => number;
  observedHeadCalls: () => number;
  setEntries: (value: GitStatusResult['entries']) => void;
  setVerificationEntries: (value: GitStatusResult['entries']) => void;
  setVerificationHead: (value: string) => void;
  setBranch: (value: string) => void;
  setHead: (value: string) => void;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umcp-retention-'));
  roots.push(root);
  const sourceRoot = path.join(root, 'goal');
  const retentionRoot = path.join(root, 'retention');
  await mkdir(path.join(sourceRoot, '.github', 'workflows'), { recursive: true });
  await mkdir(path.join(sourceRoot, 'scripts'), { recursive: true });
  await writeFile(path.join(sourceRoot, TRACKED), 'workflow-local-unmerged\n');
  await writeFile(path.join(sourceRoot, UNTRACKED), 'restart-test-local-unmerged\n');
  let entries = dirtyEntries;
  let verificationEntries: GitStatusResult['entries'] | undefined;
  let verificationHead: string | undefined;
  let branch = 'goal/goal-original';
  let head = HEAD;
  let statusCalls = 0;
  let observedHeadCalls = 0;
  const git: GoalWorkspaceRetentionGitPort = {
    async status() {
      statusCalls += 1;
      return { ok: true, value: { entries: statusCalls > 1 && verificationEntries ? verificationEntries : entries } };
    },
    async run(_cwd, args) {
      if (args[0] === 'rev-parse') {
        observedHeadCalls += 1;
        return { ok: true, value: { exitCode: 0, stdout: (observedHeadCalls > 1 && verificationHead ? verificationHead : head) + '\n', stderr: '' } };
      }
      if (args[0] === 'branch') {
        return { ok: true, value: { exitCode: 0, stdout: branch + '\n', stderr: '' } };
      }
      throw new Error('Unexpected Git command ' + args.join(' '));
    },
  };
  const request = {
    goalId: 'goal-original',
    workspaceId: 'goal-workspace-original',
    sourceRoot,
    retentionRoot,
    expectedHead: HEAD,
    expectedBranch: 'goal/goal-original',
    git,
    maxBytes: 4096,
  };
  return { root, sourceRoot, retentionRoot, request, statusCalls: (): number => statusCalls,
    observedHeadCalls: (): number => observedHeadCalls,
    setEntries: (value: GitStatusResult['entries']): void => { entries = value; },
    setVerificationEntries: (value: GitStatusResult['entries']): void => { verificationEntries = value; },
    setVerificationHead: (value: string): void => { verificationHead = value; },
    setBranch: (value: string): void => { branch = value; },
    setHead: (value: string): void => { head = value; },
  };
}

describe('sealMixedDirtyGoalWorkspace — #298', () => {
  it('independently seals the tracked and untracked contents without touching the originals', async () => {
    const t = await harness();
    const before = await Promise.all([readFile(path.join(t.sourceRoot, TRACKED)), readFile(path.join(t.sourceRoot, UNTRACKED))]);
    const result = await sealMixedDirtyGoalWorkspace(t.request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries.map((e) => [e.path, e.kind])).toEqual([
      [TRACKED, 'tracked'], [UNTRACKED, 'untracked'],
    ]);
    for (const [index, entry] of result.value.entries.entries()) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(await readFile(path.join(result.value.retentionPath, 'files', entry.path))).toEqual(before[index]);
      expect(await readFile(path.join(t.sourceRoot, entry.path))).toEqual(before[index]);
    }
    const onDisk = JSON.parse(await readFile(path.join(result.value.retentionPath, 'manifest.json'), 'utf8'));
    expect(onDisk.goalId).toBe('goal-original');
    expect(onDisk.head).toBe(HEAD);
    expect(onDisk.entries).toEqual(result.value.entries);
    expect(t.statusCalls()).toBe(2);
    expect(t.observedHeadCalls()).toBe(2);
  });

  it('refuses tracked-only, untracked-only, or unexpected staged deltas', async () => {
    const t = await harness();
    for (const entries of [
      dirtyEntries.slice(0, 1),
      dirtyEntries.slice(1),
      [{ ...dirtyEntries[0]!, indexStatus: 'M' }, dirtyEntries[1]!],
    ]) {
      t.setEntries(entries);
      const result = await sealMixedDirtyGoalWorkspace(t.request);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects path traversal and symlinks without reading outside files', async () => {
    const t = await harness();
    t.setEntries([dirtyEntries[0]!, { ...dirtyEntries[1]!, path: '../outside.txt' }]);
    expect((await sealMixedDirtyGoalWorkspace(t.request)).ok).toBe(false);
    t.setEntries(dirtyEntries);
    await rm(path.join(t.sourceRoot, UNTRACKED));
    await symlink(path.join(t.sourceRoot, TRACKED), path.join(t.sourceRoot, UNTRACKED));
    expect((await sealMixedDirtyGoalWorkspace(t.request)).ok).toBe(false);
  });

  it('blocks a retention root nested inside the source', async () => {
    const t = await harness();
    const result = await sealMixedDirtyGoalWorkspace({ ...t.request, retentionRoot: path.join(t.sourceRoot, '.unified-mpc', 'retention') });
    expect(result.ok).toBe(false);
  });

  it('blocks byte limits and missing source paths without modifying the originals', async () => {
    const t = await harness();
    expect((await sealMixedDirtyGoalWorkspace({ ...t.request, maxBytes: 2 })).ok).toBe(false);
    await rm(path.join(t.sourceRoot, UNTRACKED));
    expect((await sealMixedDirtyGoalWorkspace(t.request)).ok).toBe(false);
    expect((await stat(path.join(t.sourceRoot, TRACKED))).isFile()).toBe(true);
  });

  it('rejects HEAD, branch, or Git status drift detected during verification', async () => {
    const t = await harness();
    t.setHead('b'.repeat(40));
    expect((await sealMixedDirtyGoalWorkspace(t.request)).ok).toBe(false);
    t.setHead(HEAD);
    t.setBranch('goal/other');
    expect((await sealMixedDirtyGoalWorkspace(t.request)).ok).toBe(false);
    t.setBranch('goal/goal-original');
    t.setEntries([...dirtyEntries, { path: 'surprise.txt', kind: 'untracked', indexStatus: '?', worktreeStatus: '?' }]);
    expect((await sealMixedDirtyGoalWorkspace(t.request)).ok).toBe(false);
  });

  it('rejects an additional foreign file or changed HEAD after the copy began', async () => {
    const t = await harness();
    t.setVerificationEntries([...dirtyEntries, { path: 'surprise.txt', kind: 'untracked', indexStatus: '?', worktreeStatus: '?' }]);
    expect((await sealMixedDirtyGoalWorkspace(t.request)).ok).toBe(false);

    const u = await harness();
    u.setVerificationHead('b'.repeat(40));
    expect((await sealMixedDirtyGoalWorkspace(u.request)).ok).toBe(false);
  });
});
