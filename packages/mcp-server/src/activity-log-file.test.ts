import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ActivityTracker, type ActivitySinkEvent } from './activity-tracker.js';
import {
  ACTIVITY_LOG_MAX_BYTES_ENV,
  DEFAULT_ACTIVITY_LOG_MAX_BYTES,
  activityLogMaxBytes,
  composeActivitySinks,
  createFileActivitySink,
  formatActivityLogLine,
  mcpActivityLogArchivePath,
  mcpActivityLogPath,
} from './activity-log-file.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function activityEvent(callId: string): ActivitySinkEvent {
  return {
    callId,
    toolName: 'read_file',
    phase: 'started',
    resultCode: 'STARTED',
    durationMs: 0,
    timestamp: '2026-01-01T00:00:00.000Z',
  };
}

async function readCallIds(filePath: string): Promise<string[]> {
  const raw = await readFile(filePath, 'utf8');
  return raw.trim().split('\n').map((line) => (JSON.parse(line) as { callId: string }).callId);
}

async function temporaryLog(): Promise<{ root: string; filePath: string; lineBytes: number }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-activity-'));
  temporaryRoots.push(root);
  const filePath = mcpActivityLogPath(root);
  const lineBytes = Buffer.byteLength(formatActivityLogLine(activityEvent('c1')), 'utf8');
  return { root, filePath, lineBytes };
}

describe('mcp activity log file', () => {
  it('resolves the activity log under the shared data path', () => {
    expect(mcpActivityLogPath('C:\\Users\\me\\AppData\\Roaming\\unified-mpc')).toMatch(/mcp-activity\.log$/);
  });

  it('writes started and completed NDJSON lines that Live Logs can tail', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-activity-'));
    temporaryRoots.push(root);
    const filePath = mcpActivityLogPath(root);
    const tracker = new ActivityTracker(createFileActivitySink(filePath));

    const callId = await tracker.begin('read_file', { workspaceId: 'workspace-1', path: 'src\\app.ts' }, { sessionId: 'session-a' });
    await tracker.end(callId, 'SUCCESS', 4);

    const raw = await readFile(filePath, 'utf8');
    const lines = raw.trim().split('\n').map((line) => JSON.parse(line) as { callId: string; phase: string; toolName: string; workspaceId?: string; sessionId?: string });
    expect(lines).toEqual([
      expect.objectContaining({ callId, phase: 'started', toolName: 'read_file', workspaceId: 'workspace-1', sessionId: 'session-a' }),
      expect.objectContaining({ callId, phase: 'completed', toolName: 'read_file', workspaceId: 'workspace-1', sessionId: 'session-a' }),
    ]);
    expect(formatActivityLogLine({
      callId: 'c1',
      toolName: 'write_file',
      phase: 'completed',
      resultCode: 'FILE_NOT_FOUND',
      durationMs: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      resultMessage: 'missing',
    })).toContain('"toolName":"write_file"');
  });

  it('still records to later sinks when an earlier activity sink fails', async () => {
    const recorded: ActivitySinkEvent[] = [];
    const sink = composeActivitySinks([
      {
        async record(): Promise<void> {
          throw new Error('file sink unavailable');
        },
      },
      {
        async record(event): Promise<void> {
          recorded.push(event);
        },
      },
    ]);

    await expect(sink.record({
      callId: 'c1',
      toolName: 'read_file',
      phase: 'started',
      resultCode: 'STARTED',
      durationMs: 0,
      timestamp: '2026-08-17T00:00:00.000Z',
    })).rejects.toThrow('file sink unavailable');
    expect(recorded).toHaveLength(1);
  });

  it('serializes only the compact target reference even if a started event carries full detail', () => {
    const raw = formatActivityLogLine({
      callId: 'call-files',
      toolName: 'read_files',
      phase: 'started',
      resultCode: 'STARTED',
      durationMs: 0,
      timestamp: '2026-08-30T00:00:00.000Z',
      targetSummary: 'a.ts, b.ts, c.ts',
      targetDetail: { detailRef: 'call-files', itemCount: 7, preview: ['a.ts', 'b.ts', 'c.ts'], legacyIncomplete: false },
      detail: { kind: 'files', items: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'api_key=super-secret'] },
    } as ActivitySinkEvent & { readonly detail: { readonly kind: 'files'; readonly items: readonly string[] } });
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.targetDetail).toEqual({ detailRef: 'call-files', itemCount: 7, preview: ['a.ts', 'b.ts', 'c.ts'], legacyIncomplete: false });
    expect(parsed).not.toHaveProperty('detail');
    expect(raw).not.toContain('super-secret');
    expect(raw).not.toContain('(+');
  });
});

describe('mcp activity log retention', () => {
  it('rotates into one archive before an append would exceed the cap', async () => {
    const { filePath, lineBytes } = await temporaryLog();
    const maxBytes = lineBytes * 3 + 10;
    const sink = createFileActivitySink(filePath, { maxBytes });

    for (const callId of ['c1', 'c2', 'c3', 'c4']) await sink.record(activityEvent(callId));

    expect(await readCallIds(filePath)).toEqual(['c4']);
    expect(await readCallIds(mcpActivityLogArchivePath(filePath))).toEqual(['c1', 'c2', 'c3']);
    expect(Buffer.byteLength(await readFile(filePath, 'utf8'), 'utf8')).toBeLessThanOrEqual(maxBytes);
  });

  it('keeps only the newest archive when the file rotates again', async () => {
    const { filePath, lineBytes } = await temporaryLog();
    const sink = createFileActivitySink(filePath, { maxBytes: lineBytes * 3 + 10 });

    for (const callId of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8']) await sink.record(activityEvent(callId));

    expect(await readCallIds(filePath)).toEqual(['c7', 'c8']);
    expect(await readCallIds(mcpActivityLogArchivePath(filePath))).toEqual(['c4', 'c5', 'c6']);
  });

  it('does not rotate while the file stays under the cap', async () => {
    const { filePath } = await temporaryLog();
    const sink = createFileActivitySink(filePath, { maxBytes: 1024 * 1024 });

    for (const callId of ['c1', 'c2', 'c3']) await sink.record(activityEvent(callId));

    expect(await readCallIds(filePath)).toEqual(['c1', 'c2', 'c3']);
    await expect(readFile(mcpActivityLogArchivePath(filePath), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a single growing file when rotation is disabled', async () => {
    const { filePath } = await temporaryLog();
    const sink = createFileActivitySink(filePath, { maxBytes: 0 });

    for (const callId of ['c1', 'c2', 'c3', 'c4']) await sink.record(activityEvent(callId));

    expect(await readCallIds(filePath)).toEqual(['c1', 'c2', 'c3', 'c4']);
    await expect(readFile(mcpActivityLogArchivePath(filePath), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('still appends the event when the archive step fails', async () => {
    const { root, filePath, lineBytes } = await temporaryLog();
    // A directory at the archive path makes the rename fail for a reason other
    // than a racing rotation, which is the only generic way to force the error.
    await mkdir(path.join(root, 'mcp-activity.log.1'), { recursive: true });
    const sink = createFileActivitySink(filePath, { maxBytes: lineBytes * 2 + 10 });

    await sink.record(activityEvent('c1'));
    await sink.record(activityEvent('c2'));
    await expect(sink.record(activityEvent('c3'))).rejects.toThrow();

    expect(await readCallIds(filePath)).toEqual(['c1', 'c2', 'c3']);
  });

  it('rejects a negative cap instead of silently disabling retention', () => {
    expect(() => createFileActivitySink(mcpActivityLogPath('/tmp/unused'), { maxBytes: -1 })).toThrow(RangeError);
  });

  it('reads the cap override and falls back on malformed values', () => {
    expect(activityLogMaxBytes({})).toBe(DEFAULT_ACTIVITY_LOG_MAX_BYTES);
    expect(activityLogMaxBytes({ [ACTIVITY_LOG_MAX_BYTES_ENV]: '2048' })).toBe(2048);
    expect(activityLogMaxBytes({ [ACTIVITY_LOG_MAX_BYTES_ENV]: '0' })).toBe(0);
    expect(activityLogMaxBytes({ [ACTIVITY_LOG_MAX_BYTES_ENV]: 'not-a-number' })).toBe(DEFAULT_ACTIVITY_LOG_MAX_BYTES);
    expect(activityLogMaxBytes({ [ACTIVITY_LOG_MAX_BYTES_ENV]: '-1' })).toBe(DEFAULT_ACTIVITY_LOG_MAX_BYTES);
    expect(activityLogMaxBytes({ [ACTIVITY_LOG_MAX_BYTES_ENV]: '   ' })).toBe(DEFAULT_ACTIVITY_LOG_MAX_BYTES);
  });
});
