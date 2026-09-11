import { describe, expect, it } from 'vitest';
import { ok, type Result } from '@unified-mpc/domain';
import { EventLogCapabilityBackend } from './event-log-backend.js';

describe('EventLogCapabilityBackend', () => {
  it('reports a missing portable log executable and surfaces helper errors', async () => {
    const backend = new EventLogCapabilityBackend({
      platform: 'linux',
      portableRunner: async (): Promise<Result<string>> => ({ ok: false, error: { code: 'PROCESS_NOT_FOUND', message: 'journalctl not installed', recoverable: true } }),
    });
    await expect(backend.execute({ operation: 'crashes' })).resolves.toMatchObject({ ok: true, value: { available: false, reason: 'portable_log_provider_missing' } });

    const failing = new EventLogCapabilityBackend({
      platform: 'linux',
      portableRunner: async () => ({ ok: false as const, error: { code: 'PROCESS_TIMEOUT' as const, message: 'timeout', recoverable: true } }),
    });
    await expect(failing.execute({ operation: 'query', provider: 'my-app' })).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
  });

  it('passes bounded portable filters to the host-native log provider', async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const backend = new EventLogCapabilityBackend({
      platform: 'linux',
      portableRunner: async (executable, args): Promise<Result<string>> => {
        calls.push({ executable, args });
        return ok('[]');
      },
    });

    await expect(backend.execute({ operation: 'query', log_name: 'Application', provider: 'my-app', max_events: 4 })).resolves.toMatchObject({
      ok: true,
      value: { available: true, ready: true, count: 0, logName: 'Application', provider: 'my-app' },
    });
    expect(calls).toEqual([{ executable: 'journalctl', args: ['--no-pager', '--output=json', '-n', '4', '--user', '-t', 'my-app'] }]);
  });

  it('builds a quoted macOS predicate without exposing request text as a new argument', async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const backend = new EventLogCapabilityBackend({
      platform: 'darwin',
      portableRunner: async (executable, args): Promise<Result<string>> => {
        calls.push({ executable, args });
        return ok('[]');
      },
    });

    await backend.execute({ operation: 'crashes', provider: 'my.app', max_events: 3, since: '2026-08-21T10:00:00Z' });
    expect(calls[0]).toMatchObject({ executable: 'log' });
    expect(calls[0]?.args).toEqual([
      'show', '--style', 'ndjson', '--no-pager', '--predicate',
      '(eventMessage CONTAINS[c] "crash" OR eventMessage CONTAINS[c] "exception") AND (process == "my.app" OR subsystem == "my.app" OR senderImagePath ENDSWITH[c] "my.app")',
      '--start', '2026-08-21T10:00:00.000Z',
    ]);
  });

  it('parses macOS NDJSON fields and ignores the finished marker', async () => {
    const backend = new EventLogCapabilityBackend({
      platform: 'darwin',
      portableRunner: async (): Promise<Result<string>> => ok([
        JSON.stringify({
          timestamp: '2026-08-21 10:00:00.000000+0000',
          process: 'unified-mpc',
          processID: 42,
          messageType: 'Error',
          eventMessage: 'host failed',
        }),
        JSON.stringify({ finished: true }),
      ].join('\n')),
    });

    await expect(backend.execute({ operation: 'query', provider: 'unified-mpc' })).resolves.toMatchObject({
      ok: true,
      value: {
        count: 1,
        events: [{
          time: '2026-08-21 10:00:00.000000+0000',
          provider: 'unified-mpc',
          id: 42,
          level: 'Error',
          message: 'host failed',
        }],
      },
    });
  });
});
