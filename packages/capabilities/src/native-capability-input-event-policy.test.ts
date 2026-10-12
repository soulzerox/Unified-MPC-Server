import { describe, expect, it, vi } from 'vitest';
import { NativeCapabilityBackend } from './native-capability-backend.js';

/**
 * `input_event` and `computer_use` inject raw text into whatever window has focus. If that
 * window is a terminal the text becomes a command line, so the argv fence never sees it.
 * These tests pin the merge/push fence onto that keystroke path.
 */
const bridgeExecute = vi.fn(async (): Promise<{ ok: true; value: Record<string, unknown> }> => ({ ok: true, value: { delivered: true } }));

const backend = (): NativeCapabilityBackend => new NativeCapabilityBackend('input_event', {
  platform: 'linux',
  bridge: { execute: bridgeExecute } as never,
});

const typeText = async (text: string): Promise<{ ok: boolean; message?: string }> => {
  bridgeExecute.mockClear();
  const result = await backend().execute({ operation: 'type_text', parameters: { text }, userConfirmed: true });
  return result.ok ? { ok: true } : { ok: false, message: (result as { error?: { message?: string } }).error?.message };
};

describe('input_event type_text applies the merge fence', () => {
  const BLOCKED: [string, string][] = [
    ['direct merge', 'gh pr merge 275'],
    ['merge with flags', 'gh pr merge 275 --merge --delete-branch'],
    ['api merge', 'gh api -X PUT repos/o/r/pulls/275/merge'],
    ['chained after cd', 'cd /tmp && gh pr merge 275'],
    ['leading whitespace', '   gh pr merge 275\n'],
    ['git push', 'git push origin main'],
    ['push chained', 'git commit -m x && git push origin main'],
    ['array style smuggled', "exec('gh pr merge 275')"],
  ];

  for (const [name, text] of BLOCKED) {
    it(`blocks ${name}`, async () => {
      const result = await typeText(text);
      expect(result.ok, `expected denial for ${JSON.stringify(text)}, got ${result.message ?? 'ALLOWED'}`).toBe(false);
      expect(bridgeExecute).not.toHaveBeenCalled();
    });
  }

  const ALLOWED: [string, string][] = [
    ['ordinary prose', 'hello world'],
    ['gh read only', 'gh pr view 275'],
    ['gh pr list', 'gh pr list --state open'],
    ['git status', 'git status'],
    ['git commit only', 'git commit -m "fix: something"'],
    ['git log', 'git log --oneline -5'],
    ['prose mentioning gh repo', 'clone the repo with gh'],
    ['shutdown word in prose', 'the shutdown -h command is destructive'],
    ['markdown code fence', '```\ngit status\n```'],
  ];

  for (const [name, text] of ALLOWED) {
    it(`allows ${name}`, async () => {
      expect((await typeText(text)).ok, `unexpectedly blocked: ${JSON.stringify(text)}`).toBe(true);
      expect(bridgeExecute).toHaveBeenCalled();
    });
  }
});

describe('input_event sequence applies the fence to every step', () => {
  it('blocks a merge hidden in a later step', async () => {
    bridgeExecute.mockClear();
    const result = await backend().execute({
      operation: 'sequence',
      parameters: { steps: [
        { operation: 'type_text', parameters: { text: 'hello' } },
        { operation: 'type_text', parameters: { text: 'gh pr merge 275' } },
      ] },
      userConfirmed: true,
    });
    expect(result.ok).toBe(false);
    expect(bridgeExecute).not.toHaveBeenCalled();
  });

  it('blocks a merge when the step carries text directly', async () => {
    bridgeExecute.mockClear();
    const result = await backend().execute({
      operation: 'sequence',
      parameters: { steps: [{ operation: 'type_text', text: 'gh pr merge 275' }] },
      userConfirmed: true,
    });
    expect(result.ok).toBe(false);
    expect(bridgeExecute).not.toHaveBeenCalled();
  });

  it('allows an ordinary sequence', async () => {
    bridgeExecute.mockClear();
    const result = await backend().execute({
      operation: 'sequence',
      parameters: { steps: [
        { operation: 'type_text', parameters: { text: 'hello' } },
        { operation: 'press_key', parameters: { key: 'Enter' } },
      ] },
      userConfirmed: true,
    });
    expect(result.ok).toBe(true);
    expect(bridgeExecute).toHaveBeenCalled();
  });
});

describe('other native capabilities are unaffected', () => {
  it('accessibility set_value passes text through', async () => {
    bridgeExecute.mockClear();
    const result = await new NativeCapabilityBackend('accessibility', {
      platform: 'linux',
      bridge: { execute: bridgeExecute } as never,
    }).execute({ action: 'set_value', parameters: { value: 'gh pr merge 275' }, userConfirmed: true });
    expect(result.ok).toBe(true);
  });
});