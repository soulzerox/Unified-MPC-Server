import { describe, expect, it } from 'vitest';
import { isProvablyReadOnlyGitInvocation, parseGitPushArguments, prohibitedAgentGitInvocationReason, prohibitedDefaultBranchPushReason, prohibitedGitConfigMutationReason, prohibitedGitPushConfigOverrideReason, prohibitedGitPushGlobalOptionReason } from './git-mutation-policy.js';

describe('prohibitedAgentGitInvocationReason', () => {
  it.each([
    [['-C', 'E:\\outside', 'status'], 'global scope'],
    [['--git-dir=E:\\outside\\.git', 'status'], 'global scope'],
    [['--work-tree=E:\\outside', 'status'], 'global scope'],
    [['-c', 'alias.wipe=!rm -rf .', 'wipe'], 'alias injection'],
    [['wipe'], 'unknown/repository alias'],
    [['checkout', '--', 'src/file.ts'], 'checkout discard'],
    [['checkout', 'src/file.ts'], 'ambiguous checkout path discard'],
    [['checkout', '-f', 'main'], 'checkout force'],
    [['switch', '--discard-changes', 'main'], 'switch discard'],
    [['switch', '-C', 'main'], 'switch force-create'],
    [['stash', 'drop'], 'stash drop'],
    [['stash', 'clear'], 'stash clear'],
    [['stash', 'pop'], 'stash pop'],
    [['reflog', 'delete', 'HEAD@{1}'], 'reflog delete'],
    [['reflog', 'expire', '--expire=now', '--all'], 'reflog expire'],
    [['branch', '-D', 'old'], 'branch delete'],
    [['branch', '-f', 'main'], 'branch force'],
    [['branch', '-M', 'old', 'existing'], 'branch force rename'],
    [['branch', '-C', 'source', 'existing'], 'branch force copy'],
    [['tag', '-d', 'v1'], 'tag delete'],
    [['tag', '-f', 'v1'], 'tag force'],
    [['worktree', 'remove', 'tmp'], 'worktree remove'],
    [['worktree', 'prune'], 'worktree prune'],
    [['remote', 'remove', 'origin'], 'remote remove'],
    [['remote', 'prune', 'origin'], 'remote prune'],
    [['fetch', '--prune'], 'fetch prune'],
    [['gc'], 'gc'],
    [['mv', '-f', 'a', 'b'], 'forced mv'],
    [['push', '--force', 'origin', 'main'], 'force push'],
    [['push', '--delete', 'origin', 'old'], 'delete push'],
    [['push', '--mirror', 'origin'], 'mirror push'],
    [['push', '--prune', 'origin'], 'prune push'],
    [['push', 'origin', ':old'], 'delete refspec'],
    [['push', 'origin', '+main:main'], 'force refspec'],
    [['push'], 'implicit push'],
    [['push', 'origin'], 'implicit remote destination'],
    [['push', 'origin', 'main'], 'direct default branch push'],
    [['push', 'origin', 'HEAD:main'], 'explicit default branch destination'],
    [['push', 'origin', 'HEAD:refs/heads/main'], 'fully-qualified default branch destination'],
    [['push', 'origin', '@'], 'implicit current-branch destination'],
    [['push', '--receive-pack=/tmp/custom-receive-pack', 'origin', 'feature/review-gate'], 'custom receive-pack'],
    [['push', '--exec', '/tmp/custom-receive-pack', 'origin', 'feature/review-gate'], 'custom exec transport'],
    [['push', '--receive=/tmp/custom-receive-pack', 'origin', 'feature/review-gate'], 'abbreviated receive-pack'],
    [['push', '--exe=/tmp/custom-receive-pack', 'origin', 'feature/review-gate'], 'abbreviated exec transport'],
    [['push', '--all', 'origin'], 'all branches push'],
    [['push', 'origin', 'refs/heads/*:refs/heads/*'], 'wildcard refspec'],
  ] as const)('blocks %s (%s)', (args, _label) => {
    void _label;
    expect(prohibitedAgentGitInvocationReason(args, { defaultBranch: 'main' })).toBeTypeOf('string');
  });

  it.each([
    ['status', '--short'],
    ['diff', '--stat'],
    ['log', '-1'],
    ['add', '--', 'src/file.ts'],
    ['commit', '-m', 'safe local commit'],
    ['rm', '--', 'src/old.ts'],
    ['clean', '-fd'],
    ['reset', '--hard', 'HEAD~1'],
    ['reset', '--merge'],
    ['reset', '--keep'],
    ['reset', '--soft', 'HEAD~1'],
    ['restore', 'src/file.ts'],
    ['restore', '--worktree', 'src/file.ts'],
    ['restore', '--staged', 'src/file.ts'],
    ['remote', '-v'],
    ['stash', 'list'],
    ['push', '-u', 'origin', 'feature/review-gate'],
    ['push', 'origin', 'HEAD:feature/review-gate'],
    ['push', 'origin', 'refs/heads/feature/review-gate:refs/heads/feature/review-gate'],
    ['push', '-o', 'ci.skip', 'origin', 'feature/review-gate'],
  ] as const)('keeps reviewed non-destructive form %s available', (...args) => {
    expect(prohibitedAgentGitInvocationReason(args)).toBeUndefined();
  });

  it('classifies demonstrably read-only forms separately from allowed writes', () => {
    expect(isProvablyReadOnlyGitInvocation(['status', '--short'])).toBe(true);
    expect(isProvablyReadOnlyGitInvocation(['remote', '-v'])).toBe(true);
    expect(isProvablyReadOnlyGitInvocation(['branch'])).toBe(true);
    expect(isProvablyReadOnlyGitInvocation(['branch', '--show-current'])).toBe(true);
    expect(isProvablyReadOnlyGitInvocation(['branch', '--list'])).toBe(true);
    expect(isProvablyReadOnlyGitInvocation(['branch', '--list', 'feature/*'])).toBe(false);
    expect(isProvablyReadOnlyGitInvocation(['branch', 'new-branch'])).toBe(false);
    expect(isProvablyReadOnlyGitInvocation(['branch', '-D', 'old'])).toBe(false);
    expect(isProvablyReadOnlyGitInvocation(['add', '--', 'src/file.ts'])).toBe(false);
    expect(isProvablyReadOnlyGitInvocation(['commit', '-m', 'message'])).toBe(false);
  });

  it('protects a repository default branch without assuming main or master', () => {
    expect(prohibitedAgentGitInvocationReason(['push', 'origin', 'trunk'], { defaultBranch: 'trunk' })).toBeTypeOf('string');
    expect(prohibitedAgentGitInvocationReason(['push', 'origin', 'HEAD:refs/heads/production'], { defaultBranch: 'production' })).toBeTypeOf('string');
    expect(prohibitedAgentGitInvocationReason(['push', 'origin', 'main'], { defaultBranch: 'trunk' })).toBeUndefined();
  });

  it('rejects wildcard push refspecs independently of default-branch resolution', () => {
    expect(prohibitedDefaultBranchPushReason(['origin', 'refs/heads/*:refs/heads/*'])).toBeTypeOf('string');
  });

  it('parses push options with values before locating the remote', () => {
    expect(parseGitPushArguments(['-o', 'ci.skip', '-u', 'origin', 'feature/review-gate'])).toEqual({
      remote: 'origin',
      refspecs: ['feature/review-gate'],
    });
  });

  it('keeps --repo push syntax available for an explicit feature ref', () => {
    expect(parseGitPushArguments(['--repo=origin', 'feature/review-gate'])).toEqual({
      remote: 'origin',
      refspecs: ['feature/review-gate'],
    });
    expect(prohibitedAgentGitInvocationReason(['push', '--repo', 'origin', 'feature/review-gate'])).toBeUndefined();
  });

  it.each([
    ['-c', 'color.ui=false', 'push', 'origin', 'feature/review-gate'],
    ['-c', 'include.path=/tmp/override.cfg', 'push', 'origin', 'feature/review-gate'],
    ['--config-env=include.path=GIT_INCLUDE', 'push', 'origin', 'feature/review-gate'],
    ['--config-env', 'include.path=GIT_INCLUDE', 'push', 'origin', 'feature/review-gate'],
  ] as const)('rejects push-time config overrides %s', (...args) => {
    expect(prohibitedGitPushConfigOverrideReason(args)).toBeTypeOf('string');
  });

  it.each([
    ['--exec-path=/tmp/custom-bin', 'push', 'origin', 'feature/review-gate'],
    ['--exec-path', '/tmp/custom-bin', 'push', 'origin', 'feature/review-gate'],
  ] as const)('rejects push-time Git executable path overrides %s', (...args) => {
    expect(prohibitedGitPushGlobalOptionReason(args)).toBeTypeOf('string');
  });

  it.each([
    ['config', 'core.sshCommand', '/tmp/ssh-wrapper'],
    ['config', '--add', 'remote.origin.uploadpack', '/tmp/upload-pack'],
    ['config', '--unset', 'credential.helper'],
    ['config', 'protocol.ext.allow', 'always'],
  ] as const)('rejects executable Git config mutation %s', (...args) => {
    expect(prohibitedGitConfigMutationReason(args)).toBeTypeOf('string');
  });
});
