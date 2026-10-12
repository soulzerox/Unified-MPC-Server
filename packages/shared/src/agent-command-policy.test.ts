import { describe, expect, it } from 'vitest';
import { prohibitedAgentCommandReason, prohibitedUnscopedGitPushReason, prohibitedUnscopedPullRequestMergeReason, riskyAgentCommandReason } from './agent-command-policy.js';

describe('agent command policy', () => {
  it.each([
    ['reboot', []],
    ['shutdown', ['-h', 'now']],
    ['poweroff', []],
    ['halt', []],
  ] as const)('hard-blocks machine-level command %s', (executable, args) => {
    expect(prohibitedAgentCommandReason(executable, args)).toBeDefined();
  });

  it.each([
    ['node', ['-e', "const fs=require('fs'); fs.writeFileSync('src/a.ts', 'next')"]],
    ['python3', ['-c', "open('src/a.py', 'w', encoding='utf8').write('next')"]],
    ['sed', ['-i.bak', 's/a/b/', 'src/a.txt']],
  ] as const)('routes terminal-style text editing away from command tool %s', (executable, args) => {
    expect(prohibitedAgentCommandReason(executable, args)).toContain('Use edit_file');
  });

  it.each([
    ['rm', ['-rf', 'target']],
    ['unlink', ['target']],
    ['shred', ['target']],
    ['truncate', ['-s', '0', 'target']],
    ['dd', ['if=/dev/zero', 'of=target']],
    ['bash', ['-lc', 'rm -rf target']],
    ['node', ['--eval', 'require("fs").rmSync("x")']],
    ['python3', ['-c', 'import os; os.remove("x")']],
    ['rsync', ['-a', '--delete', 'source/', 'target/']],
  ] as const)('requires confirmation for risky command %s', (executable, args) => {
    expect(prohibitedAgentCommandReason(executable, args)).toBeUndefined();
    expect(riskyAgentCommandReason(executable, args)).toBeDefined();
  });

  it.each([
    [['clean', '-fd']],
    [['reset', '--hard']],
    [['restore', '--worktree', '.']],
    [['push', '--force', 'origin', 'main']],
  ] as const)('requires confirmation for destructive git invocation %j', (args) => {
    expect(riskyAgentCommandReason('git', args)).toBeDefined();
  });

  it.each([
    ['pnpm', ['test']],
    ['cp', ['source', 'target']],
    ['mv', ['source', 'target']],
    ['node', ['script.js']],
    ['python3', ['script.py']],
    ['bash', ['-c', 'echo ok']],
    ['git', ['status', '--short']],
  ] as const)('allows normal command without confirmation: %s', (executable, args) => {
    expect(prohibitedAgentCommandReason(executable, args)).toBeUndefined();
    expect(riskyAgentCommandReason(executable, args)).toBeUndefined();
  });

  it.each([
    ['git', ['push', 'origin', 'feature/review-gate']],
    ['git', ['-C', '/outside', 'push', 'origin', 'feature/review-gate']],
    ['bash', ['-lc', 'git -c color.ui=false push origin feature/review-gate']],
    ['bash', ['-lc', 'git -C /outside push origin feature/review-gate']],
    ['powershell.exe', ['-Command', 'git.exe push origin feature/review-gate']],
    ['cmd.exe', ['/c', '"git push origin feature/review-gate"']],
  ] as const)('hard-blocks unscoped Git push execution: %s', (executable, args) => {
    expect(prohibitedUnscopedGitPushReason(executable, args)).toBeDefined();
    expect(prohibitedAgentCommandReason(executable, args)).toBeDefined();
  });

  it.each([
    ['gh', ['pr', 'merge', '275']],
    ['gh.exe', ['--repo', 'soulzerox/Unified-MPC-Server', 'pr', 'merge', '275', '--merge']],
    ['bash', ['-lc', 'gh pr merge 275 --merge']],
    ['powershell.exe', ['-Command', 'gh.exe --repo soulzerox/Unified-MPC-Server pr merge 275 --merge']],
    ['cmd.exe', ['/c', '"gh pr merge 275 --merge"']],
  ] as const)('hard-blocks unscoped GitHub PR merge execution: %s', (executable, args) => {
    expect(prohibitedUnscopedPullRequestMergeReason(executable, args)).toContain('exact-head');
    expect(prohibitedAgentCommandReason(executable, args)).toBeDefined();
  });

  it.each([
    ['gh', ['api', '-X', 'PUT', 'repos/soulzerox/Unified-MPC-Server/pulls/275/merge']],
    ['gh', ['api', '-X', 'POST', 'repos/soulzerox/Unified-MPC-Server/merges']],
    ['gh.exe', ['--repo', 'soulzerox/Unified-MPC-Server', 'api', '-X', 'PUT', 'repos/soulzerox/Unified-MPC-Server/pulls/275/merge']],
    ['gh', ['api', 'graphql', '-f', 'query=mutation{mergePullRequest(input:{}){clientMutationId}}']],
    ['gh', ['api', 'graphql', '-f', 'query=mutation{enablePullRequestAutoMerge(input:{}){clientMutationId}}']],
    ['bash', ['-lc', 'gh api -X PUT repos/soulzerox/Unified-MPC-Server/pulls/275/merge']],
    ['powershell.exe', ['-Command', 'gh api -X PUT repos/soulzerox/Unified-MPC-Server/pulls/275/merge']],
  ] as const)('hard-blocks unscoped GitHub merge API execution: %s', (executable, args) => {
    expect(prohibitedUnscopedPullRequestMergeReason(executable, args)).toContain('exact-head');
    expect(prohibitedAgentCommandReason(executable, args)).toBeDefined();
  });

  it.each([
    ['node', ['-e', "require('child_process').execSync('gh pr merge 275 --merge')"]],
    ['node', ['-p', "'gh pr merge 275'"]],
    ['node', ['--eval', "exec('gh api -X PUT repos/o/r/pulls/275/merge')"]],
    ['bun', ['-e', "exec('gh pr merge 275')"]],
    ['deno', ['eval', "await new Deno.Command('gh',{args:['pr','merge','275']})"]],
    ['python3', ['-c', "os.system('gh pr merge 275')"]],
    ['python', ['-c', "subprocess.run(['gh','api','-X','PUT','repos/o/r/pulls/275/merge'])"]],
    ['perl', ['-e', 'system("gh pr merge 275")']],
    ['ruby', ['-e', 'system("gh pr merge 275")']],
  ] as const)('hard-blocks merge smuggled through an inline interpreter: %s', (executable, args) => {
    expect(prohibitedUnscopedPullRequestMergeReason(executable, args)).toContain('exact-head');
    expect(prohibitedAgentCommandReason(executable, args)).toBeDefined();
  });

  it.each([
    ['env', ['gh', 'pr', 'merge', '275']],
    ['env', ['-i', 'gh', 'pr', 'merge', '275']],
    ['env', ['GH_TOKEN=x', 'gh', 'pr', 'merge', '275']],
    ['env', ['--', 'gh', 'pr', 'merge', '275']],
    ['env', ['gh', 'api', '-X', 'PUT', 'repos/o/r/pulls/275/merge']],
    ['xargs', ['gh', 'pr', 'merge']],
    ['xargs', ['-0', 'gh', 'api', '-X', 'PUT', 'repos/o/r/pulls/275/merge']],
    ['nohup', ['gh', 'pr', 'merge', '275']],
    ['setsid', ['gh', 'pr', 'merge', '275']],
  ] as const)('hard-blocks merge smuggled through an argument wrapper: %s', (executable, args) => {
    expect(prohibitedUnscopedPullRequestMergeReason(executable, args)).toContain('exact-head');
    expect(prohibitedAgentCommandReason(executable, args)).toBeDefined();
  });

  it.each([
    ['gh', ['alias', 'set', 'mm', 'pr merge 275']],
    ['gh', ['alias', 'set', 'mm', 'api -X PUT repos/o/r/pulls/275/merge']],
  ] as const)('hard-blocks defining a merge alias that later runs unguarded: %s', (executable, args) => {
    expect(prohibitedUnscopedPullRequestMergeReason(executable, args)).toContain('exact-head');
    expect(prohibitedAgentCommandReason(executable, args)).toBeDefined();
  });

  it.each([
    ['node', ['-e', 'console.log(1)']],
    ['node', ['-e', "exec('gh pr view 275')"]],
    ['python3', ['-c', "subprocess.run(['gh','pr','list'])"]],
    ['env', ['NODE_ENV=test', 'gh', 'pr', 'view', '275']],
    ['env', ['node', '-e', 'console.log(1)']],
    ['xargs', ['-0', 'rg', 'merge']],
    ['gh', ['alias', 'set', 'st', 'pr status']],
    ['gh', ['alias', 'list']],
    ['gh', ['alias', 'delete', 'mm']],
  ] as const)('allows non-merge wrapper and interpreter invocations: %s', (executable, args) => {
    expect(prohibitedUnscopedPullRequestMergeReason(executable, args)).toBeUndefined();
    expect(prohibitedAgentCommandReason(executable, args)).toBeUndefined();
  });

  it.each([
    ['gh', ['api', 'repos/soulzerox/Unified-MPC-Server/pulls/275']],
    ['gh', ['api', 'repos/soulzerox/Unified-MPC-Server/commits/abc123/check-runs']],
    ['gh', ['api', 'graphql', '-f', 'query={viewer{login}}']],
    ['gh', ['api', 'repos/soulzerox/Unified-MPC-Server/issues/1/comments', '-f', 'body=Please merge pull request when ready']],
    ['gh', ['api', 'search/issues', '-f', 'q=merge pull request']],
  ] as const)('allows non-merge GitHub merge-adjacent API reads: %s', (executable, args) => {
    expect(prohibitedUnscopedPullRequestMergeReason(executable, args)).toBeUndefined();
    expect(prohibitedAgentCommandReason(executable, args)).toBeUndefined();
  });

  it.each([
    ['gh', ['pr', 'view', '275']],
    ['gh.exe', ['--repo', 'soulzerox/Unified-MPC-Server', 'pr', 'checks', '275']],
    ['bash', ['-lc', 'gh pr status']],
  ] as const)('allows non-merge GitHub CLI PR commands: %s', (executable, args) => {
    expect(prohibitedUnscopedPullRequestMergeReason(executable, args)).toBeUndefined();
    expect(prohibitedAgentCommandReason(executable, args)).toBeUndefined();
  });

});
