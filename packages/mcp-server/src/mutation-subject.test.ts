import { describe, expect, it } from 'vitest';
import { codeMutationPaths } from './harness-runtime.js';
import {
  PATH_NAMED_MUTATION_TOOLS,
  isRestoreMutationTool,
  resolveMutationSubjects,
  type MutationSubjectResolvers,
} from './mutation-subject.js';

const resolvers = (overrides: Partial<MutationSubjectResolvers> = {}): MutationSubjectResolvers => ({
  recoveryPaths: () => undefined,
  checkpointPaths: () => undefined,
  ...overrides,
});

describe('resolveMutationSubjects', () => {
  it('keeps the path-named set and the extractor in agreement', () => {
    // A tool that one side switches on and the other does not resolves to
    // opaque/command and keeps its mutation ungated, so the two lists are
    // pinned here rather than discovered in production.
    for (const tool of PATH_NAMED_MUTATION_TOOLS) {
      expect(codeMutationPaths(tool, {
        path: 'src/app.ts',
        sourcePath: 'src/app.ts',
        destinationPath: 'src/app.ts',
        file: 'src/app.ts',
        files: [{ path: 'src/app.ts' }],
      }), tool).toContain('src/app.ts');
    }
  });

  it('returns the artifact paths a request names, filtered and deduplicated', async () => {
    await expect(resolveMutationSubjects('write_file', { path: 'src/app.ts' })).resolves.toEqual({
      kind: 'paths', paths: ['src/app.ts'], origin: 'request',
    });
    // A non-artifact is a path subject with nothing to prepare, not an opaque
    // one: the gate governs code, and a doc write must not demand evidence.
    await expect(resolveMutationSubjects('write_file', { path: 'docs/readme.md' })).resolves.toEqual({
      kind: 'paths', paths: [], origin: 'request',
    });
    await expect(resolveMutationSubjects('move_file', { sourcePath: 'src/a.ts', destinationPath: 'src/b.ts' })).resolves.toEqual({
      kind: 'paths', paths: ['src/a.ts', 'src/b.ts'], origin: 'request',
    });
    await expect(resolveMutationSubjects('move_file', { sourcePath: 'src/app.ts', destinationPath: './src/app.ts' })).resolves.toEqual({
      kind: 'paths', paths: ['src/app.ts'], origin: 'request',
    });
  });

  it('resolves a recovery id into the path the store holds', async () => {
    const subject = await resolveMutationSubjects('restore_deleted_file', { recoveryId: 'recovery-1' }, resolvers({
      recoveryPaths: (recoveryId) => recoveryId === 'recovery-1' ? ['src/app.ts'] : undefined,
    }));
    expect(subject).toEqual({ kind: 'paths', paths: ['src/app.ts'], origin: 'store' });
  });

  it('resolves a checkpoint id into every development artifact it restores', async () => {
    const subject = await resolveMutationSubjects('restore_checkpoint', { checkpointId: 'checkpoint-1' }, resolvers({
      checkpointPaths: () => ['src/app.ts', 'docs/readme.md', 'src/lib/util.ts', 'src/lib/util.ts'],
    }));
    expect(subject).toEqual({ kind: 'paths', paths: ['src/app.ts', 'src/lib/util.ts'], origin: 'store' });
  });

  it('is opaque about a subject it cannot resolve instead of inventing a path list', async () => {
    // An unknown id, an unreadable store and a missing service pick all answer
    // `undefined`, and all three keep today's behaviour rather than refusing a
    // mutation on evidence that does not exist.
    await expect(resolveMutationSubjects('restore_deleted_file', { recoveryId: 'missing' }, resolvers())).resolves.toEqual({
      kind: 'opaque', reason: 'unresolved',
    });
    await expect(resolveMutationSubjects('restore_checkpoint', { checkpointId: 'missing' })).resolves.toEqual({
      kind: 'opaque', reason: 'unresolved',
    });
    await expect(resolveMutationSubjects('restore_deleted_file', { recoveryId: 'recovery-1' }, resolvers({
      recoveryPaths: () => { throw new Error('store offline'); },
    }))).resolves.toEqual({ kind: 'opaque', reason: 'unresolved' });
  });

  it('is opaque about a command, which names no artifact at all', async () => {
    for (const tool of ['shell', 'wsl_exec', 'process_start', 'git', 'git_publish', 'codex_run', 'agent_swarm_run']) {
      await expect(resolveMutationSubjects(tool, { command: 'rm src/app.ts' }), tool).resolves.toEqual({
        kind: 'opaque', reason: 'command',
      });
    }
    // A restore request that does not even name its subject is the same case:
    // the store could not have answered a request with no id.
    await expect(resolveMutationSubjects('restore_deleted_file', { userConfirmed: true })).resolves.toEqual({
      kind: 'opaque', reason: 'command',
    });
  });

  it('recognises the restore tools the seam has to ask about', () => {
    for (const tool of ['restore_deleted_file', 'restore_recovery_item', 'restore_checkpoint']) {
      expect(isRestoreMutationTool(tool), tool).toBe(true);
    }
    for (const tool of ['write_file', 'shell', 'list_recovery_items']) {
      expect(isRestoreMutationTool(tool), tool).toBe(false);
    }
  });
});
