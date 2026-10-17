import { describe, expect, it } from 'vitest';
import { startNativeProviderOrDegrade } from './native-provider-startup.js';

describe('native provider startup degradation (#210 U31)', () => {
  it('reports ready and writes nothing when the provider starts', async () => {
    const lines: string[] = [];
    const state = await startNativeProviderOrDegrade(
      async () => undefined,
      (line) => lines.push(line),
    );
    expect(state).toBe('ready');
    expect(lines).toEqual([]);
  });

  it('degrades instead of failing the whole server when the provider cannot start', async () => {
    const lines: string[] = [];
    const state = await startNativeProviderOrDegrade(
      async () => {
        throw new Error('Thai-RAG provider owner is locked but not reachable: Connection closed');
      },
      (line) => lines.push(line),
    );
    expect(state).toBe('degraded');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('state=degraded');
    expect(lines[0]).toContain('owner is locked but not reachable');
  });

  it('degrades on a non-Error rejection and still keeps the reason', async () => {
    const lines: string[] = [];
    const state = await startNativeProviderOrDegrade(
      async () => {
        throw 'socket closed';
      },
      (line) => lines.push(line),
    );
    expect(state).toBe('degraded');
    expect(lines[0]).toContain('socket closed');
  });
});
