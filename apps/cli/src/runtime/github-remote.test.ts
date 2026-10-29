import { describe, expect, it, vi } from 'vitest';
import {
  githubRepositoryFromRemote,
  parseGitRemote,
  sshHostnameFromConfig,
} from './github-remote.js';

const REPOSITORY = 'soulzerox/Unified-MPC-Server';

describe('parseGitRemote', () => {
  it.each([
    [`https://github.com/${REPOSITORY}`, 'https'],
    [`https://github.com/${REPOSITORY}.git`, 'https'],
    [`https://github.com/${REPOSITORY}/`, 'https'],
    [`https://GitHub.com/${REPOSITORY}.git`, 'https'],
    [`git@github.com:${REPOSITORY}.git`, 'ssh'],
    [`ssh://git@github.com/${REPOSITORY}.git`, 'ssh'],
    [`ssh://git@github.com:22/${REPOSITORY}.git`, 'ssh'],
  ] as const)('parses %s', (remote, protocol) => {
    expect(parseGitRemote(remote)).toEqual({
      protocol,
      host: 'github.com',
      repository: REPOSITORY,
    });
  });

  it('parses another HTTPS host without claiming it is GitHub', () => {
    expect(parseGitRemote(`https://gitlab.com/${REPOSITORY}.git`)).toEqual({
      protocol: 'https',
      host: 'gitlab.com',
      repository: REPOSITORY,
    });
  });

  it.each([
    '',
    'not-a-remote',
    'git@github.com:soulzerox',
    `git@github.com:${REPOSITORY}/extra`,
    `https://github.com/${REPOSITORY}/tree/main`,
    `https://token@github.com/${REPOSITORY}.git`,
    'git@github.com:../repo.git',
  ])('rejects %s', (remote) => {
    expect(parseGitRemote(remote)).toBeUndefined();
  });
});

describe('githubRepositoryFromRemote', () => {
  it('accepts the canonical host without resolving an ssh alias', async () => {
    const resolve = vi.fn(async () => 'github.com');

    await expect(githubRepositoryFromRemote(`git@github.com:${REPOSITORY}.git`, resolve))
      .resolves.toBe(REPOSITORY);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('accepts an ssh host alias that resolves to github.com', async () => {
    const resolve = vi.fn(async () => 'github.com');

    await expect(githubRepositoryFromRemote(`git@github.com-unified:${REPOSITORY}.git`, resolve))
      .resolves.toBe(REPOSITORY);
    expect(resolve).toHaveBeenCalledWith('github.com-unified');
  });

  it('rejects an ssh alias that resolves to another host', async () => {
    await expect(githubRepositoryFromRemote(
      `git@github.com-unified:${REPOSITORY}.git`,
      async () => 'github.example.com',
    )).resolves.toBeUndefined();
  });

  it('fails closed when the ssh alias cannot be resolved', async () => {
    await expect(githubRepositoryFromRemote(
      `git@github.com-unified:${REPOSITORY}.git`,
      async () => { throw new Error('ssh unavailable'); },
    )).resolves.toBeUndefined();
  });

  it('rejects a non-GitHub https remote without resolving it', async () => {
    const resolve = vi.fn(async () => 'github.com');

    await expect(githubRepositoryFromRemote(`https://gitlab.com/${REPOSITORY}.git`, resolve))
      .resolves.toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('sshHostnameFromConfig', () => {
  it('reads the resolved hostname and ignores the alias line', () => {
    expect(sshHostnameFromConfig('host github.com-unified\nhostname github.com\nuser git\n'))
      .toBe('github.com');
  });

  it('returns undefined when ssh prints no hostname', () => {
    expect(sshHostnameFromConfig('user git\n')).toBeUndefined();
  });
});
