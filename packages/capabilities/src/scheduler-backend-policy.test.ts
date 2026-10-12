import { describe, expect, it, vi } from 'vitest';
import { SchedulerCapabilityBackend } from './scheduler-backend.js';

const create = async (command: string, args: readonly string[]): Promise<{ ok: boolean; message?: string }> => {
  const runImpl = vi.fn(async (): Promise<{ stdout: string; stderr: string }> => ({ stdout: 'SUCCESS', stderr: '' }));
  const backend = new SchedulerCapabilityBackend({ platform: 'win32', runImpl });
  const result = await backend.execute({
    action: 'create', task_name: 'T', command, arguments: [...args],
    schedule: 'DAILY', start_time: '09:30', userConfirmed: true,
  });
  return result.ok
    ? { ok: true }
    : { ok: false, message: (result as { error?: { message?: string } }).error?.message };
};

describe('scheduler create enforces the same agent command policy as shell', () => {
  const BLOCKED: [string, string, readonly string[]][] = [
    ['pr merge', 'gh', ['pr', 'merge', '275', '--merge']],
    ['pr merge array style', 'gh', ['api', '-X', 'PUT', 'repos/o/r/pulls/275/merge']],
    ['env-wrapped merge', 'env', ['gh', 'pr', 'merge', '275']],
    ['inline script merge', 'node', ['-e', "exec('gh pr merge 275')"]],
    ['shell -c merge', 'bash', ['-c', 'gh pr merge 275']],
    ['git push', 'git', ['push', 'origin', 'main']],
    ['shutdown hard block', 'shutdown', ['-h']],
  ];

  for (const [name, command, args] of BLOCKED) {
    it(`blocks ${name}`, async () => {
      const result = await create(command, args);
      expect(result.ok, `expected denial for ${command} ${args.join(' ')}, got ${result.message ?? 'ALLOWED'}`).toBe(false);
    });
  }

  const ALLOWED: [string, string, readonly string[]][] = [
    ['legit app', 'C:\\Program Files\\app\\tool.exe', ['--flag', 'value with space']],
    ['git status', 'git', ['status']],
    ['gh pr view', 'gh', ['pr', 'view', '275']],
  ];

  for (const [name, command, args] of ALLOWED) {
    it(`allows ${name}`, async () => {
      expect((await create(command, args)).ok).toBe(true);
    });
  }

  it('never reaches schtasks for a blocked command', async () => {
    const runImpl = vi.fn(async (): Promise<{ stdout: string; stderr: string }> => ({ stdout: 'SUCCESS', stderr: '' }));
    const backend = new SchedulerCapabilityBackend({ platform: 'win32', runImpl });
    await backend.execute({
      action: 'create', task_name: 'T', command: 'gh', arguments: ['pr', 'merge', '275'],
      schedule: 'DAILY', start_time: '09:30', userConfirmed: true,
    });
    expect(runImpl).not.toHaveBeenCalled();
  });
});

