import { describe, expect, it } from 'vitest';
import { prohibitedAgentCommandReason, riskyAgentCommandReason } from './agent-command-policy.js';

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
});
