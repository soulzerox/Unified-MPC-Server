import { mkdir, appendFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { decodeActivityTargetReference, Redactor } from '@unified-mpc/audit';
import type { ActivitySink, ActivitySinkEvent } from './activity-tracker.js';

/**
 * Durable activity log retention.
 *
 * `live_logs_query` serves only the last 4 MiB of the file (`readJsonlTail`),
 * so a cap of the same size keeps every line the tool can read in the active
 * file. One rotated archive is kept for an operator who needs older evidence;
 * together they bound the log at two caps instead of letting it grow for the
 * life of the host.
 */
export const DEFAULT_ACTIVITY_LOG_MAX_BYTES = 4 * 1024 * 1024;

export const ACTIVITY_LOG_MAX_BYTES_ENV = 'UNIFIED_MPC_ACTIVITY_LOG_MAX_BYTES';

export function mcpActivityLogPath(dataPath: string): string {
  return path.join(dataPath, 'mcp-activity.log');
}

export function mcpActivityLogArchivePath(filePath: string): string {
  return `${filePath}.1`;
}

/**
 * A malformed or negative override falls back to the default instead of
 * failing runtime startup: the log is diagnostics, not a safety gate.
 */
export function activityLogMaxBytes(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment[ACTIVITY_LOG_MAX_BYTES_ENV]?.trim();
  if (raw === undefined || raw.length === 0) return DEFAULT_ACTIVITY_LOG_MAX_BYTES;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return DEFAULT_ACTIVITY_LOG_MAX_BYTES;
  return parsed;
}

export function formatActivityLogLine(event: ActivitySinkEvent): string {
  const redactor = new Redactor();
  return `${JSON.stringify({
    callId: event.callId,
    toolName: event.toolName,
    phase: event.phase,
    resultCode: event.resultCode,
    durationMs: event.durationMs,
    timestamp: event.timestamp,
    ...(event.workspaceId === undefined ? {} : { workspaceId: event.workspaceId }),
    ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
    ...(event.targetSummary === undefined ? {} : { targetSummary: redactor.redactText(event.targetSummary) }),
    targetDetail: decodeActivityTargetReference(event.targetDetail, event.targetSummary),
    ...(event.resultMessage === undefined ? {} : { resultMessage: redactor.redactText(event.resultMessage) }),
    ...(event.traceId === undefined ? {} : { traceId: event.traceId }),
    ...(event.traceParent === undefined ? {} : { traceParent: event.traceParent }),
  })}\n`;
}

export interface FileActivitySinkOptions {
  /**
   * Rotate to `<file>.1` before an append that would exceed this many bytes.
   * `0` disables rotation and keeps a single growing file.
   */
  readonly maxBytes?: number;
}

export function createFileActivitySink(filePath: string, options: FileActivitySinkOptions = {}): ActivitySink {
  const maxBytes = options.maxBytes ?? DEFAULT_ACTIVITY_LOG_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('activity log maxBytes must be a non-negative integer');
  }
  return {
    async record(event: ActivitySinkEvent): Promise<void> {
      const line = formatActivityLogLine(event);
      await mkdir(path.dirname(filePath), { recursive: true });
      let rotationError: unknown;
      if (maxBytes > 0) {
        try {
          await rotateIfNeeded(filePath, Buffer.byteLength(line, 'utf8'), maxBytes);
        } catch (error: unknown) {
          // The event is appended first and the rotation failure reported after,
          // so a broken archive step can never drop the line being recorded.
          rotationError = error;
        }
      }
      await appendFile(filePath, line, 'utf8');
      if (rotationError !== undefined) throw rotationError;
    },
  };
}

/**
 * Best effort: several runtimes can share one data directory (the HTTP service
 * and a Web process both build a sink), so a racing writer may have rotated
 * between the two size reads. Re-checking immediately before the rename keeps
 * the common case from archiving a fresh file; a lost race only moves recent
 * lines into the archive, it never corrupts or duplicates them.
 */
async function rotateIfNeeded(filePath: string, incomingBytes: number, maxBytes: number): Promise<void> {
  const currentBytes = await fileSize(filePath);
  if (currentBytes === undefined || currentBytes === 0) return;
  if (currentBytes + incomingBytes <= maxBytes) return;
  const recheckedBytes = await fileSize(filePath);
  if (recheckedBytes === undefined || recheckedBytes === 0) return;
  if (recheckedBytes + incomingBytes <= maxBytes) return;
  try {
    // POSIX rename replaces an existing archive atomically, so only one archive
    // is ever kept and a crash leaves either the old or the new file, not both.
    await rename(filePath, mcpActivityLogArchivePath(filePath));
  } catch (error: unknown) {
    if (isMissingFile(error)) return;
    throw error;
  }
}

async function fileSize(filePath: string): Promise<number | undefined> {
  try {
    return (await stat(filePath)).size;
  } catch (error: unknown) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { readonly code?: unknown }).code === 'ENOENT';
}

export function composeActivitySinks(sinks: readonly ActivitySink[]): ActivitySink {
  return {
    async record(event: ActivitySinkEvent): Promise<void> {
      const errors: unknown[] = [];
      for (const sink of sinks) {
        try {
          await sink.record(event);
        } catch (error: unknown) {
          errors.push(error);
        }
      }
      if (errors.length > 0) throw errors[0];
    },
  };
}
