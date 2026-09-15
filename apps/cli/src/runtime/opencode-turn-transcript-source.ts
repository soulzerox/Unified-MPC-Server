import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  stageTurnTranscript,
  type CompletedTurnTranscript,
} from '@unified-mpc/mcp-server';

const SOURCE_STATE_DIRECTORY = 'turn-sources';
const SOURCE_STATE_FILE = 'opencode.json';
const SOURCE_LEASE_FILE = 'opencode.lock';
const MAX_TRANSCRIPT_BYTES = 60_000;
const MAX_TRACKED_SESSIONS_PER_DATABASE = 1_024;
const DEFAULT_SCAN_INTERVAL_MS = 2_000;

type StageResult = Awaited<ReturnType<typeof stageTurnTranscript>>;

interface SessionRow {
  readonly id: string;
  readonly directory: string;
  readonly timeUpdated: number;
}

interface ExtractedTurn {
  readonly assistantId: string;
  readonly completionMs: number;
  readonly userMs: number;
  readonly userMessage: string;
  readonly assistantMessage: string;
}

interface SessionCursor {
  readonly lastSessionUpdated: number;
  readonly lastCompletionMs: number;
  readonly stagedCount: number;
  readonly updatedAt: string;
}

interface DatabaseCursor {
  readonly sessions: Readonly<Record<string, SessionCursor>>;
}

interface PersistentSourceState {
  readonly version: 1;
  readonly initialized: boolean;
  readonly databases: Readonly<Record<string, DatabaseCursor>>;
}

export interface OpenCodeTurnTranscriptSourceStatus {
  readonly state: 'active' | 'degraded' | 'unavailable';
  readonly sourceClient: 'opencode';
  readonly captureMode: 'automatic';
  readonly autoRecordTurn: boolean;
  readonly roots: number;
  readonly stagedTurns: number;
  readonly lastScanAt?: string;
  readonly lastError?: string;
}

export interface OpenCodeTurnTranscriptSourceOptions {
  readonly dataPath: string;
  readonly key: Uint8Array;
  readonly databasePaths?: readonly string[];
  readonly intervalMs?: number;
  readonly stage?: (turn: CompletedTurnTranscript) => Promise<StageResult>;
}

/** Reads OpenCode's persisted SQLite session/message/part store read-only. */
export class OpenCodeTurnTranscriptSource {
  private readonly dataPath: string;
  private readonly key: Buffer;
  private readonly configuredDatabasePaths: readonly string[] | undefined;
  private readonly intervalMs: number;
  private readonly stage: (turn: CompletedTurnTranscript) => Promise<StageResult>;
  private readonly statePath: string;
  private readonly leasePath: string;
  private readonly leaseToken = randomBytes(16).toString('hex');
  private ownsProducerLease = false;
  private timer: NodeJS.Timeout | undefined;
  private scanPromise: Promise<void> | undefined;
  private persistentState: PersistentSourceState = { version: 1, initialized: false, databases: {} };
  private runtimeStatus: OpenCodeTurnTranscriptSourceStatus = {
    state: 'unavailable',
    sourceClient: 'opencode',
    captureMode: 'automatic',
    autoRecordTurn: false,
    roots: 0,
    stagedTurns: 0,
  };

  public constructor(options: OpenCodeTurnTranscriptSourceOptions) {
    if (options.key.byteLength !== 32) throw new Error('OpenCode turn transcript ingress key must be exactly 32 bytes');
    this.dataPath = options.dataPath;
    this.key = Buffer.from(options.key);
    this.configuredDatabasePaths = options.databasePaths;
    this.intervalMs = normalizeInterval(options.intervalMs);
    this.statePath = path.join(this.dataPath, SOURCE_STATE_DIRECTORY, SOURCE_STATE_FILE);
    this.leasePath = path.join(this.dataPath, SOURCE_STATE_DIRECTORY, SOURCE_LEASE_FILE);
    this.stage = options.stage ?? ((turn): Promise<StageResult> => stageTurnTranscript(this.dataPath, this.key, turn));
  }

  public async initialize(): Promise<void> {
    this.persistentState = await readSourceState(this.statePath);
    await this.scanInternal();
  }

  public start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => { void this.scan(); }, this.intervalMs);
    this.timer.unref?.();
  }

  public async close(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.scanPromise?.catch(() => undefined);
    await this.releaseProducerLease();
  }

  public status(): OpenCodeTurnTranscriptSourceStatus {
    return { ...this.runtimeStatus };
  }

  public scan(): Promise<void> {
    if (this.scanPromise !== undefined) return this.scanPromise;
    this.scanPromise = this.scanInternal().finally(() => { this.scanPromise = undefined; });
    return this.scanPromise;
  }

  private async scanInternal(): Promise<void> {
    const databases = await discoverOpenCodeDatabases(this.configuredDatabasePaths);
    if (databases.length === 0) {
      this.runtimeStatus = {
        ...this.runtimeStatus,
        state: 'unavailable',
        autoRecordTurn: false,
        roots: 0,
        lastScanAt: new Date().toISOString(),
      };
      return;
    }
    if (!await this.ensureProducerLease()) {
      this.runtimeStatus = {
        ...this.runtimeStatus,
        state: 'unavailable',
        autoRecordTurn: false,
        roots: databases.length,
        lastScanAt: new Date().toISOString(),
        lastError: 'Another Unified MCP runtime owns the OpenCode transcript producer lease',
      };
      return;
    }

    const firstSuccessfulScan = !this.persistentState.initialized;
    const mutableDatabases: Record<string, DatabaseCursor> = { ...this.persistentState.databases };
    let stagedTurns = this.runtimeStatus.stagedTurns;
    try {
      for (const databasePath of databases) {
        const databaseKey = sourceRootKey(databasePath);
        const previousDatabase = mutableDatabases[databaseKey] ?? { sessions: {} };
        const sessionCursors: Record<string, SessionCursor> = { ...previousDatabase.sessions };
        const database = new DatabaseSync(databasePath, { readOnly: true });
        try {
          ensureSupportedSchema(database, databasePath);
          const sessions = readSessions(database);
          for (const session of sessions) {
            const previous = sessionCursors[session.id];
            if (firstSuccessfulScan) {
              sessionCursors[session.id] = baselineCursor(session);
              continue;
            }
            if (previous !== undefined && session.timeUpdated <= previous.lastSessionUpdated) continue;

            let cursor = previous ?? {
              lastSessionUpdated: 0,
              lastCompletionMs: 0,
              stagedCount: 0,
              updatedAt: new Date(0).toISOString(),
            };
            const turns = readCompletedTurns(database, session.id);
            for (const turn of turns) {
              if (turn.completionMs <= cursor.lastCompletionMs) continue;
              const sequence = cursor.stagedCount + 1;
              const transcript = toTranscript(databaseKey, session, turn, sequence);
              const staged = await this.stage(transcript);
              if (!staged.ok) throw new Error(staged.error.message);
              cursor = {
                lastSessionUpdated: session.timeUpdated,
                lastCompletionMs: turn.completionMs,
                stagedCount: sequence,
                updatedAt: new Date().toISOString(),
              };
              sessionCursors[session.id] = cursor;
              stagedTurns += staged.value.duplicate ? 0 : 1;
              await this.persist({ ...mutableDatabases, [databaseKey]: { sessions: pruneSessionCursors(sessionCursors) } }, true);
            }
            sessionCursors[session.id] = {
              ...cursor,
              lastSessionUpdated: Math.max(cursor.lastSessionUpdated, session.timeUpdated),
              updatedAt: new Date().toISOString(),
            };
          }
          mutableDatabases[databaseKey] = { sessions: pruneSessionCursors(sessionCursors) };
        } finally {
          database.close();
        }
      }

      this.persistentState = { version: 1, initialized: true, databases: mutableDatabases };
      await writeAtomic(this.statePath, JSON.stringify(this.persistentState));
      this.runtimeStatus = {
        state: 'active',
        sourceClient: 'opencode',
        captureMode: 'automatic',
        autoRecordTurn: true,
        roots: databases.length,
        stagedTurns,
        lastScanAt: new Date().toISOString(),
      };
    } catch (error: unknown) {
      this.runtimeStatus = {
        state: 'degraded',
        sourceClient: 'opencode',
        captureMode: 'automatic',
        autoRecordTurn: false,
        roots: databases.length,
        stagedTurns,
        lastScanAt: new Date().toISOString(),
        lastError: errorMessage(error),
      };
    }
  }

  private async persist(databases: Readonly<Record<string, DatabaseCursor>>, initialized: boolean): Promise<void> {
    this.persistentState = { version: 1, initialized, databases };
    await writeAtomic(this.statePath, JSON.stringify(this.persistentState));
  }

  private async ensureProducerLease(): Promise<boolean> {
    if (this.ownsProducerLease) return true;
    await mkdir(path.dirname(this.leasePath), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await writeFile(this.leasePath, JSON.stringify({ version: 1, pid: process.pid, token: this.leaseToken, createdAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
        this.ownsProducerLease = true;
        return true;
      } catch (error: unknown) {
        if (!isAlreadyExistsError(error)) throw error;
        const existing = await readProducerLease(this.leasePath);
        if (existing !== null && processIsAlive(existing.pid)) return false;
        await unlink(this.leasePath).catch(() => undefined);
      }
    }
    return false;
  }

  private async releaseProducerLease(): Promise<void> {
    if (!this.ownsProducerLease) return;
    const existing = await readProducerLease(this.leasePath);
    if (existing?.token === this.leaseToken) await unlink(this.leasePath).catch(() => undefined);
    this.ownsProducerLease = false;
  }
}

export function defaultOpenCodeDatabasePaths(homeDir: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const override = env.UNIFIED_MPC_OPENCODE_DB?.trim();
  if (override) return dedupePaths(override.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean));
  const dataHome = env.XDG_DATA_HOME?.trim() || path.join(homeDir, '.local', 'share');
  return dedupePaths([path.join(dataHome, 'opencode', 'opencode.db')]);
}

async function discoverOpenCodeDatabases(configured: readonly string[] | undefined): Promise<readonly string[]> {
  const candidates = configured ?? defaultOpenCodeDatabasePaths();
  const available: string[] = [];
  for (const candidate of dedupePaths(candidates)) {
    try {
      await access(candidate);
      const db = new DatabaseSync(candidate, { readOnly: true });
      try { ensureSupportedSchema(db, candidate); } finally { db.close(); }
      available.push(path.resolve(candidate));
    } catch { /* unsupported/not installed */ }
  }
  return available;
}

function ensureSupportedSchema(database: DatabaseSync, databasePath: string): void {
  const rows = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('session','message','part')").all() as Array<{ name?: unknown }>;
  const names = new Set(rows.map((row) => String(row.name)));
  for (const required of ['session', 'message', 'part']) {
    if (!names.has(required)) throw new Error(`Unsupported OpenCode database schema (${required} missing): ${databasePath}`);
  }
}

function readSessions(database: DatabaseSync): readonly SessionRow[] {
  const rows = database.prepare('SELECT id, directory, time_updated FROM session WHERE directory IS NOT NULL ORDER BY time_updated, id').all() as Record<string, unknown>[];
  const sessions: SessionRow[] = [];
  for (const row of rows) {
    const id = boundedString(row.id, 1, 256);
    const directory = boundedString(row.directory, 1, 4_096);
    const timeUpdated = validEpochMs(row.time_updated);
    if (id !== undefined && directory !== undefined && timeUpdated !== undefined) sessions.push({ id, directory, timeUpdated });
  }
  return sessions;
}

function readCompletedTurns(database: DatabaseSync, sessionId: string): readonly ExtractedTurn[] {
  const messages = database.prepare('SELECT id, time_created, time_updated, data FROM message WHERE session_id=? ORDER BY time_created, id').all(sessionId) as Record<string, unknown>[];
  const parts = database.prepare('SELECT message_id, time_created, data FROM part WHERE session_id=? ORDER BY time_created, id').all(sessionId) as Record<string, unknown>[];
  const textByMessage = new Map<string, string[]>();
  for (const row of parts) {
    const messageId = boundedString(row.message_id, 1, 256);
    if (messageId === undefined || typeof row.data !== 'string') continue;
    const data = parseJsonRecord(row.data);
    if (data?.type !== 'text' || data.synthetic === true) continue;
    const text = boundedTranscriptText(data.text);
    if (text === undefined) continue;
    const bucket = textByMessage.get(messageId) ?? [];
    bucket.push(text);
    textByMessage.set(messageId, bucket);
  }

  const userById = new Map<string, { readonly at: number; readonly text: string }>();
  const assistants: Array<{ readonly id: string; readonly parentId: string; readonly completionMs: number }> = [];
  for (const row of messages) {
    const id = boundedString(row.id, 1, 256);
    if (id === undefined || typeof row.data !== 'string') continue;
    const data = parseJsonRecord(row.data);
    if (data === undefined) continue;
    const text = boundedTranscriptText((textByMessage.get(id) ?? []).join('\n\n'));
    if (data.role === 'user') {
      const time = isRecord(data.time) ? validEpochMs(data.time.created) : undefined;
      const fallback = validEpochMs(row.time_created);
      if (text !== undefined && (time ?? fallback) !== undefined) userById.set(id, { at: time ?? fallback!, text });
      continue;
    }
    if (data.role !== 'assistant' || data.finish !== 'stop' || data.error !== undefined) continue;
    const parentId = boundedString(data.parentID, 1, 256);
    const completed = isRecord(data.time) ? validEpochMs(data.time.completed) : undefined;
    const fallback = validEpochMs(row.time_updated);
    if (parentId !== undefined && text !== undefined && (completed ?? fallback) !== undefined) assistants.push({ id, parentId, completionMs: completed ?? fallback! });
  }

  const turns: ExtractedTurn[] = [];
  for (const assistant of assistants.sort((a, b) => a.completionMs - b.completionMs || a.id.localeCompare(b.id))) {
    const user = userById.get(assistant.parentId);
    const assistantText = boundedTranscriptText((textByMessage.get(assistant.id) ?? []).join('\n\n'));
    if (user === undefined || assistantText === undefined) continue;
    turns.push({
      assistantId: assistant.id,
      completionMs: assistant.completionMs,
      userMs: Math.min(user.at, assistant.completionMs),
      userMessage: user.text,
      assistantMessage: assistantText,
    });
  }
  return turns;
}

function toTranscript(databaseKey: string, session: SessionRow, turn: ExtractedTurn, sequence: number): CompletedTurnTranscript {
  const safeSessionId = stableId(session.id);
  const safeAssistantId = stableId(turn.assistantId);
  return {
    version: 1,
    sessionId: `opencode:${databaseKey}:${safeSessionId}`,
    turnId: `opencode:${databaseKey}:${safeAssistantId}`,
    projectRef: session.directory,
    sequence,
    userMessage: turn.userMessage,
    assistantMessage: turn.assistantMessage,
    userTimestamp: new Date(turn.userMs).toISOString(),
    assistantTimestamp: new Date(turn.completionMs).toISOString(),
    sourceClient: 'opencode',
    metadata: { openCodeSessionId: session.id, openCodeAssistantMessageId: turn.assistantId },
  };
}

function baselineCursor(session: SessionRow): SessionCursor {
  return {
    lastSessionUpdated: session.timeUpdated,
    lastCompletionMs: session.timeUpdated,
    stagedCount: 0,
    updatedAt: new Date().toISOString(),
  };
}

function pruneSessionCursors(sessions: Readonly<Record<string, SessionCursor>>): Readonly<Record<string, SessionCursor>> {
  const entries = Object.entries(sessions);
  if (entries.length <= MAX_TRACKED_SESSIONS_PER_DATABASE) return sessions;
  return Object.fromEntries(entries.sort(([, a], [, b]) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, MAX_TRACKED_SESSIONS_PER_DATABASE));
}

async function readSourceState(filePath: string): Promise<PersistentSourceState> {
  try {
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    if (!isRecord(raw) || raw.version !== 1 || typeof raw.initialized !== 'boolean' || !isRecord(raw.databases)) throw new Error('invalid state');
    return raw as unknown as PersistentSourceState;
  } catch {
    return { version: 1, initialized: false, databases: {} };
  }
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(temp, content, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, filePath);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

interface ProducerLease { readonly version: 1; readonly pid: number; readonly token: string }

async function readProducerLease(filePath: string): Promise<ProducerLease | null> {
  try {
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    if (!isRecord(raw) || raw.version !== 1 || !Number.isSafeInteger(raw.pid) || (raw.pid as number) <= 0 || typeof raw.token !== 'string') return null;
    return { version: 1, pid: raw.pid as number, token: raw.token };
  } catch { return null; }
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (error: unknown) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM';
  }
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try { const parsed = JSON.parse(value) as unknown; return isRecord(parsed) ? parsed : undefined; } catch { return undefined; }
}

function boundedTranscriptText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return truncateUtf8(trimmed, MAX_TRANSCRIPT_BYTES);
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.byteLength <= maxBytes) return value;
  const marker = '\n[truncated by Unified MCP turn source]';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  let slice = encoded.subarray(0, Math.max(0, maxBytes - markerBytes));
  while (slice.length > 0) {
    const decoded = slice.toString('utf8');
    if (Buffer.from(decoded, 'utf8').equals(slice)) return decoded + marker;
    slice = slice.subarray(0, slice.length - 1);
  }
  return marker.trimStart();
}

function validEpochMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000 ? value : undefined;
}

function boundedString(value: unknown, min: number, max: number): string | undefined {
  return typeof value === 'string' && value.trim().length >= min && value.length <= max ? value : undefined;
}

function stableId(value: string): string {
  return value.length <= 96 ? value : createHash('sha256').update(value).digest('hex');
}

function sourceRootKey(root: string): string {
  return createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);
}

function dedupePaths(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => path.resolve(value)))];
}

function normalizeInterval(value: number | undefined): number {
  return Number.isSafeInteger(value) && value !== undefined && value >= 250 && value <= 60_000 ? value : DEFAULT_SCAN_INTERVAL_MS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
