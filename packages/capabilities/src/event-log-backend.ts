import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { CapabilityBackend } from './local-capability-service.js';
import { sanitizedChildEnvironment } from './sanitized-child-environment.js';

export interface EventLogBackendOptions {
  readonly platform?: NodeJS.Platform;
  readonly timeoutSeconds?: number;
  /** Injectable host-native runner for Linux journal/macOS Unified Log. */
  readonly portableRunner?: EventLogPortableRunner;
}

export type EventLogPortableRunner = (
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<Result<string>>;

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_EVENTS_HARD_LIMIT = 500;
const execFileAsync = promisify(execFile);

export class EventLogCapabilityBackend implements CapabilityBackend {
  private readonly platform: NodeJS.Platform;
  private readonly timeoutSeconds: number;
  private readonly portableRunner: EventLogPortableRunner;

  public constructor(options: EventLogBackendOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.timeoutSeconds = Math.min(600, Math.max(1, options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS));
    this.portableRunner = options.portableRunner ?? defaultPortableRunner(this.timeoutSeconds);
  }

  public async execute(input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    if (signal?.aborted === true) return err(appError('PROCESS_TIMEOUT', 'Event log query was cancelled', true));
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return err(appError('INVALID_INPUT', 'Event log input must be an object'));
    }
    const request = input as Record<string, unknown>;
    const mode = request.operation === 'crashes' ? 'crashes' : 'query';
    return this.executePortable(mode, request, signal);
  }

  private async executePortable(mode: 'query' | 'crashes', request: Record<string, unknown>, signal?: AbortSignal): Promise<Result<unknown>> {
    const maxEvents = clampInteger(request.max_events ?? request.maxEvents, 100, 1, MAX_EVENTS_HARD_LIMIT);
    const hours = clampNumber(request.hours, 24, 1, 720);
    const since = readTrimmedString(request.since);
    if (since !== undefined && !Number.isFinite(Date.parse(since))) {
      return err(appError('INVALID_INPUT', 'since must be an ISO-8601 timestamp'));
    }
    const logName = readTrimmedString(request.log_name ?? request.logName);
    const provider = readTrimmedString(request.provider);
    if (mode !== 'crashes' && logName === undefined && provider === undefined) {
      return err(appError('INVALID_INPUT', 'event_watch requires log_name or provider'));
    }
    const normalizedSince = since === undefined ? undefined : new Date(Date.parse(since)).toISOString();
    const invocation = portableInvocation(this.platform, mode, {
      maxEvents,
      hours,
      ...(normalizedSince === undefined ? {} : { since: normalizedSince }),
      ...(logName === undefined ? {} : { logName }),
      ...(provider === undefined ? {} : { provider }),
    });
    if (invocation === null) return ok({ available: false, ready: false, local: true, reason: 'portable_log_provider_missing', backend: `${this.platform}-native-log`, mode });
    const result = await this.portableRunner(invocation.executable, invocation.args, signal);
    if (!result.ok) {
      if (result.error.code === 'PROCESS_NOT_FOUND') return ok({ available: false, ready: false, local: true, reason: 'portable_log_provider_missing', backend: `${this.platform}-native-log`, mode });
      return result;
    }
    const events = parsePortableEvents(result.value, this.platform, maxEvents);
    return ok({ available: true, ready: true, local: true, backend: `${this.platform}-native-log`, mode, count: events.length, events, ...(provider === undefined ? {} : { provider }), ...(logName === undefined ? {} : { logName }) });
  }
}

function portableInvocation(
  platform: NodeJS.Platform,
  mode: 'query' | 'crashes',
  input: {
    readonly maxEvents: number;
    readonly hours: number;
    readonly since?: string;
    readonly logName?: string;
    readonly provider?: string;
  },
): { readonly executable: string; readonly args: readonly string[] } | null {
  if (platform === 'darwin') {
    const args = ['show', '--style', 'ndjson', '--no-pager'];
    if (input.since === undefined) args.push('--last', `${input.hours}h`);
    const predicates: string[] = [];
    if (mode === 'crashes') predicates.push('(eventMessage CONTAINS[c] "crash" OR eventMessage CONTAINS[c] "exception")');
    if (input.provider !== undefined) {
      const provider = predicateLiteral(input.provider);
      predicates.push(`(process == ${provider} OR subsystem == ${provider} OR senderImagePath ENDSWITH[c] ${provider})`);
    }
    if (predicates.length > 0) args.push('--predicate', predicates.join(' AND '));
    if (input.since !== undefined) args.push('--start', input.since);
    return { executable: 'log', args };
  }
  if (platform === 'linux') {
    const args = ['--no-pager', '--output=json', '-n', String(input.maxEvents)];
    if (input.logName?.toLowerCase() === 'application') args.push('--user');
    if (mode === 'crashes') args.push('-p', 'err..emerg');
    if (input.provider !== undefined) args.push('-t', input.provider);
    if (input.since !== undefined) args.push('--since', input.since);
    return { executable: 'journalctl', args };
  }
  return null;
}

function predicateLiteral(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function parsePortableEvents(raw: string, platform: NodeJS.Platform, maxEvents: number): readonly Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (events.length >= maxEvents) break;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const records = Array.isArray(parsed) ? parsed : [parsed];
      for (const value of records) {
        if (events.length >= maxEvents) break;
        if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
        if (platform === 'darwin' && 'finished' in value) continue;
        const record = value as Record<string, unknown>;
        const time = platform === 'linux'
          ? record.__REALTIME_TIMESTAMP ?? record._SOURCE_REALTIME_TIMESTAMP
          : record.timestamp ?? record.time;
        const message = platform === 'linux' ? record.MESSAGE : record.eventMessage;
        const provider = platform === 'linux'
          ? record.SYSLOG_IDENTIFIER
          : record.process ?? record.processImagePath ?? record.sender ?? record.senderImagePath;
        const id = platform === 'linux' ? record._PID : record.processID ?? record.processIdentifier;
        const level = platform === 'linux' ? record.PRIORITY : record.messageType ?? record.logType;
        events.push({
          time: typeof time === 'string' || typeof time === 'number' ? String(time) : null,
          provider: typeof provider === 'string' ? provider : null,
          id: typeof id === 'string' || typeof id === 'number' ? id : null,
          level: typeof level === 'string' || typeof level === 'number' ? level : null,
          message: typeof message === 'string' ? message.slice(0, 16_384) : JSON.stringify(record).slice(0, 16_384),
        });
      }
    } catch {
      // skip invalid frames
    }
  }
  return events;
}

function defaultPortableRunner(timeoutSeconds: number): EventLogPortableRunner {
  return async (executable, args, signal): Promise<Result<string>> => {
    try {
      const result = await execFileAsync(executable, [...args], {
        shell: false,
        env: sanitizedChildEnvironment(),
        encoding: 'utf8',
        timeout: timeoutSeconds * 1_000,
        maxBuffer: 4 * 1024 * 1024,
        ...(signal === undefined ? {} : { signal }),
      });
      return ok(typeof result.stdout === 'string' ? result.stdout : '');
    } catch (error: unknown) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined;
      if (code === 'ENOENT') return err(appError('PROCESS_NOT_FOUND', `${executable} is unavailable`, true));
      if (code === 'ETIMEDOUT' || code === 'ABORT_ERR') return err(appError('PROCESS_TIMEOUT', `${executable} query timed out`, true));
      return err(appError('INTERNAL_ERROR', `${executable} query failed`, true));
    }
  };
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.trunc(parsed))) : fallback;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
