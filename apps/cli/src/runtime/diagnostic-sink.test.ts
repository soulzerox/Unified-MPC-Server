import type { ActivitySinkEvent } from '@unified-mpc/mcp-server';
import { describe, expect, it, vi } from 'vitest';
import { createActivityRecordErrorSink, createStderrDiagnosticSink } from './diagnostic-sink.js';

describe('createStderrDiagnosticSink', () => {
  it('writes the redacted message and stack as one greppable record', () => {
    const write = vi.fn<(chunk: string) => void>();
    const sink = createStderrDiagnosticSink({ label: 'Unified-MPC MCP HTTP', write });

    sink({
      name: 'Error',
      message: 'Connection closed',
      stack: 'Error: Connection closed\n    at Client.close (client.ts:1:1)',
    });

    expect(write).toHaveBeenCalledTimes(1);
    const record = write.mock.calls[0]?.[0] ?? '';
    expect(record.startsWith('Unified-MPC MCP HTTP internal error name=Error message=Connection closed\n')).toBe(true);
    expect(record).toContain('at Client.close');
    expect(record.endsWith('\n')).toBe(true);
  });

  it('omits the stack when the sanitizer kept none', () => {
    const write = vi.fn<(chunk: string) => void>();
    createStderrDiagnosticSink({ write })({ name: 'UnknownError', message: 'Non-Error exception' });

    expect((write.mock.calls[0]?.[0] ?? '').trimEnd()).toBe(
      'Unified-MPC internal error name=UnknownError message=Non-Error exception',
    );
  });

  it('never escapes when stderr itself is broken', () => {
    const write = vi.fn<(chunk: string) => void>(() => {
      throw new Error('EPIPE');
    });

    expect(() => createStderrDiagnosticSink({ write })({ name: 'Error', message: 'boom' })).not.toThrow();
  });
});

describe('createActivityRecordErrorSink', () => {
  const event: ActivitySinkEvent = {
    callId: 'call-1',
    toolName: 'read_file',
    phase: 'completed',
    resultCode: 'OK',
    durationMs: 4,
    timestamp: '2026-01-01T00:00:00.000Z',
  };

  it('writes the tool, phase, result code and error as one greppable record', () => {
    const write = vi.fn<(chunk: string) => void>();
    const sink = createActivityRecordErrorSink({ label: 'Unified-MPC MCP stdio', write });

    sink(new Error('EISDIR: illegal operation on a directory, rename'), event);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toBe(
      'Unified-MPC MCP stdio activity record failed: tool=read_file phase=completed code=OK error=EISDIR: illegal operation on a directory, rename\n',
    );
  });

  it('formats a non-Error rejection', () => {
    const write = vi.fn<(chunk: string) => void>();
    createActivityRecordErrorSink({ write })('boom', event);

    expect((write.mock.calls[0]?.[0] ?? '').trimEnd()).toBe(
      'Unified-MPC activity record failed: tool=read_file phase=completed code=OK error=boom',
    );
  });

  it('never escapes when stderr itself is broken', () => {
    const write = vi.fn<(chunk: string) => void>(() => {
      throw new Error('EPIPE');
    });

    expect(() => createActivityRecordErrorSink({ write })(new Error('boom'), event)).not.toThrow();
  });
});
