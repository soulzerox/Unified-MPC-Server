import { PassThrough } from 'node:stream';

import { appError, err, ok, type Result } from '@unified-mpc/domain';
import { describe, expect, it } from 'vitest';

import { PipeTransport, ProcessManagerMcpClientFactory, type CapabilityWorkerPipes, type CapabilityWorkerSource } from './capability-worker-client-factory.js';
import type { McpServerLaunchConfig } from './types.js';

const LAUNCH = { command: '/usr/bin/node', args: ['worker.js'], cwd: '/opt/provider' } as const;

function config(overrides: Partial<McpServerLaunchConfig> = {}): McpServerLaunchConfig {
  return { command: LAUNCH.command, args: [...LAUNCH.args], cwd: LAUNCH.cwd, ...overrides };
}

/**
 * A worker that answers `initialize` over its pipes and nothing else: enough for
 * the client handshake, and it echoes the version the client asked for, which is
 * what a real provider does.
 */
function fakeWorker(): CapabilityWorkerPipes {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let buffered = '';
  stdin.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      const frame = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf('\n');
      if (frame.length === 0) continue;
      const message = JSON.parse(frame) as { id?: number; method?: string; params?: { protocolVersion?: string } };
      if (message.method === 'initialize' && message.id !== undefined) {
        stdout.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
            capabilities: {},
            serverInfo: { name: 'fake-worker', version: '1.0.0' },
          },
        })}\n`);
      }
    }
  });
  return { stdin, stdout, stderr: new PassThrough() };
}

function source(options: {
  pipes?: CapabilityWorkerPipes | undefined;
  acquire?: () => Promise<Result<{ readonly release: () => Result<void> }>>;
} = {}): { source: CapabilityWorkerSource; acquires: string[]; releases: number } {
  const acquires: string[] = [];
  const state = { releases: 0 };
  return {
    acquires,
    get releases(): number {
      return state.releases;
    },
    source: {
      async acquire(id: string): Promise<Result<{ readonly release: () => Result<void> }>> {
        acquires.push(id);
        if (options.acquire !== undefined) return options.acquire();
        return ok({
          release: (): Result<void> => {
            state.releases += 1;
            return ok(undefined);
          },
        });
      },
      pipes: (): CapabilityWorkerPipes | undefined => options.pipes,
    },
  };
}

describe('ProcessManagerMcpClientFactory', () => {
  it('leases before it connects and releases when the session closes', async () => {
    const harness = source({ pipes: fakeWorker() });
    const factory = new ProcessManagerMcpClientFactory({ source: harness.source, manifestId: 'provider', launch: LAUNCH });

    const session = await factory.connect(config());
    expect(harness.acquires).toEqual(['provider']);
    expect(harness.releases).toBe(0);

    await session.close();
    await session.close();
    expect(harness.releases).toBe(1);
  });

  it('releases the lease when the worker exposes no pipes', async () => {
    const harness = source({ pipes: undefined });
    const factory = new ProcessManagerMcpClientFactory({ source: harness.source, manifestId: 'provider', launch: LAUNCH });

    await expect(factory.connect(config())).rejects.toThrow(/exposes no pipes/);
    expect(harness.releases).toBe(1);
  });

  it('surfaces a refused lease without connecting', async () => {
    const harness = source({
      pipes: fakeWorker(),
      acquire: async () => err(appError('CONFLICT', 'capability provider is in a crash loop')),
    });
    const factory = new ProcessManagerMcpClientFactory({ source: harness.source, manifestId: 'provider', launch: LAUNCH });

    await expect(factory.connect(config())).rejects.toThrow(/refused the lease: capability provider is in a crash loop/);
    expect(harness.releases).toBe(0);
  });

  it('refuses a launch config the worker was not registered for, before leasing', async () => {
    const harness = source({ pipes: fakeWorker() });
    const factory = new ProcessManagerMcpClientFactory({ source: harness.source, manifestId: 'provider', launch: LAUNCH });

    await expect(factory.connect(config({ args: ['other.js'] }))).rejects.toThrow(/not registered for/);
    await expect(factory.connect(config({ type: 'http', url: 'http://127.0.0.1:1' }))).rejects.toThrow(/cannot serve a http transport/);
    expect(harness.acquires).toEqual([]);
  });
});

describe('PipeTransport', () => {
  it('frames outbound messages as one JSON line each', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const written: string[] = [];
    stdin.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')));
    const transport = new PipeTransport({ stdin, stdout, stderr: new PassThrough() });

    await transport.start();
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' });

    expect(written.join('')).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    await transport.close();
  });

  it('delivers only whole lines, and reports a malformed frame once', async () => {
    const stdout = new PassThrough();
    const transport = new PipeTransport({ stdin: new PassThrough(), stdout, stderr: new PassThrough() });
    const received: unknown[] = [];
    const errors: Error[] = [];
    let closes = 0;
    transport.onmessage = (message): void => {
      received.push(message);
    };
    transport.onerror = (error): void => {
      errors.push(error);
    };
    transport.onclose = (): void => {
      closes += 1;
    };

    await transport.start();
    // A half frame must not be delivered, and the next write completes it.
    stdout.write('{"jsonrpc":"2.0","id":1,"result":');
    expect(received).toHaveLength(0);
    stdout.write('{}}\n');
    expect(received).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);

    stdout.write('not json\n');
    expect(errors).toHaveLength(1);
    expect(closes).toBe(1);
    // A frame after the failure is dropped rather than delivered half-parsed.
    stdout.write('{"jsonrpc":"2.0","id":2,"result":{}}\n');
    expect(received).toHaveLength(1);
  });
});
