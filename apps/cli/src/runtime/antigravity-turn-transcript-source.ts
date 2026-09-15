import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  stageTurnTranscript,
  type CompletedTurnTranscript,
} from '@unified-mpc/mcp-server';

const SOURCE_STATE_DIRECTORY = 'turn-sources';
const SOURCE_STATE_FILE = 'antigravity.json';
const SOURCE_LEASE_FILE = 'antigravity.lock';
const SUMMARY_DATABASE_FILE = 'conversation_summaries.db';
const TRANSCRIPT_RELATIVE_PATH = path.join('.system_generated', 'logs', 'transcript.jsonl');
const MAX_TRANSCRIPT_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 60_000;
const MAX_TRACKED_CONVERSATIONS_PER_ROOT = 1_024;
const DEFAULT_SCAN_INTERVAL_MS = 2_000;

type StageResult = Awaited<ReturnType<typeof stageTurnTranscript>>;

interface ConversationSummary {
  readonly conversationId: string;
  readonly stepCount: number;
  readonly lastModified: string;
  readonly projectRef: string;
  readonly idle: boolean;
}

interface TranscriptEvent {
  readonly stepIndex: number;
  readonly source: string;
  readonly type: string;
  readonly status: string;
  readonly createdAt: string;
  readonly content?: string;
  readonly toolCalls: number;
}

interface ExtractedTurn {
  readonly assistantStep: number;
  readonly assistantTimestamp: string;
  readonly userStep: number;
  readonly userTimestamp: string;
  readonly userMessage: string;
  readonly assistantMessage: string;
}

interface ConversationCursor {
  readonly lastModified: string;
  readonly lastAssistantStep: number;
  readonly stagedCount: number;
  readonly updatedAt: string;
}

interface RootCursor {
  readonly conversations: Readonly<Record<string, ConversationCursor>>;
}

interface PersistentSourceState {
  readonly version: 1;
  readonly initialized: boolean;
  readonly roots: Readonly<Record<string, RootCursor>>;
}

export interface AntigravityTurnTranscriptSourceStatus {
  readonly state: 'active' | 'degraded' | 'unavailable';
  readonly sourceClient: 'antigravity';
  readonly captureMode: 'automatic';
  readonly autoRecordTurn: boolean;
  readonly roots: number;
  readonly stagedTurns: number;
  readonly lastScanAt?: string;
  readonly lastError?: string;
}

export interface AntigravityTurnTranscriptSourceOptions {
  readonly dataPath: string;
  readonly key: Uint8Array;
  readonly storageRoots?: readonly string[];
  readonly intervalMs?: number;
  readonly stage?: (turn: CompletedTurnTranscript) => Promise<StageResult>;
}

/**
 * Reads Antigravity's persisted conversation index and transcript journal.
 * The summary SQLite database is used only as a cheap change/idle detector;
 * user and assistant text comes from the per-conversation transcript.jsonl.
 */
export class AntigravityTurnTranscriptSource {
  private readonly dataPath: string;
  private readonly key: Buffer;
  private readonly configuredRoots: readonly string[] | undefined;
  private readonly intervalMs: number;
  private readonly stage: (turn: CompletedTurnTranscript) => Promise<StageResult>;
  private readonly statePath: string;
  private readonly leasePath: string;
  private readonly leaseToken = randomBytes(16).toString('hex');
  private ownsProducerLease = false;
  private timer: NodeJS.Timeout | undefined;
  private scanPromise: Promise<void> | undefined;
  private persistentState: PersistentSourceState = { version: 1, initialized: false, roots: {} };
  private runtimeStatus: AntigravityTurnTranscriptSourceStatus = {
    state: 'unavailable',
    sourceClient: 'antigravity',
    captureMode: 'automatic',
    autoRecordTurn: false,
    roots: 0,
    stagedTurns: 0,
  };

  public constructor(options: AntigravityTurnTranscriptSourceOptions) {
    if (options.key.byteLength !== 32) throw new Error('Antigravity turn transcript ingress key must be exactly 32 bytes');
    this.dataPath = options.dataPath;
    this.key = Buffer.from(options.key);
    this.configuredRoots = options.storageRoots;
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

  public status(): AntigravityTurnTranscriptSourceStatus {
    return { ...this.runtimeStatus };
  }

  public scan(): Promise<void> {
    if (this.scanPromise !== undefined) return this.scanPromise;
    this.scanPromise = this.scanInternal().finally(() => { this.scanPromise = undefined; });
    return this.scanPromise;
  }

  private async scanInternal(): Promise<void> {
    const roots = await discoverAntigravityRoots(this.configuredRoots);
    if (roots.length === 0) {
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
        roots: roots.length,
        lastScanAt: new Date().toISOString(),
        lastError: 'Another Unified MCP runtime owns the Antigravity transcript producer lease',
      };
      return;
    }

    const firstSuccessfulScan = !this.persistentState.initialized;
    const mutableRoots: Record<string, RootCursor> = { ...this.persistentState.roots };
    let stagedTurns = this.runtimeStatus.stagedTurns;
    try {
      for (const root of roots) {
        const rootKey = sourceRootKey(root);
        const previousRoot = mutableRoots[rootKey] ?? { conversations: {} };
        const conversationCursors: Record<string, ConversationCursor> = { ...previousRoot.conversations };
        const database = new DatabaseSync(path.join(root, SUMMARY_DATABASE_FILE), { readOnly: true });
        try {
          ensureSupportedSchema(database, root);
          const summaries = readConversationSummaries(database);
          for (const summary of summaries) {
            const previous = conversationCursors[summary.conversationId];
            if (firstSuccessfulScan) {
              conversationCursors[summary.conversationId] = baselineCursor(summary);
              continue;
            }
            if (previous !== undefined && previous.lastModified === summary.lastModified) continue;
            // Do not advance the cursor while a cascade is still running. If the
            // process crashes, the later idle scan must still see the full turn.
            if (!summary.idle) continue;

            let cursor = previous ?? {
              lastModified: '',
              lastAssistantStep: -1,
              stagedCount: 0,
              updatedAt: new Date(0).toISOString(),
            };
            const turns = await readCompletedTurns(root, summary.conversationId);
            for (const turn of turns) {
              if (turn.assistantStep <= cursor.lastAssistantStep) continue;
              const sequence = cursor.stagedCount + 1;
              const transcript = toTranscript(rootKey, summary, turn, sequence);
              const staged = await this.stage(transcript);
              if (!staged.ok) throw new Error(staged.error.message);
              cursor = {
                lastModified: summary.lastModified,
                lastAssistantStep: turn.assistantStep,
                stagedCount: sequence,
                updatedAt: new Date().toISOString(),
              };
              conversationCursors[summary.conversationId] = cursor;
              stagedTurns += staged.value.duplicate ? 0 : 1;
              await this.persist({ ...mutableRoots, [rootKey]: { conversations: pruneConversationCursors(conversationCursors) } }, true);
            }
            conversationCursors[summary.conversationId] = {
              ...cursor,
              lastModified: summary.lastModified,
              updatedAt: new Date().toISOString(),
            };
          }
          mutableRoots[rootKey] = { conversations: pruneConversationCursors(conversationCursors) };
        } finally {
          database.close();
        }
      }

      this.persistentState = { version: 1, initialized: true, roots: mutableRoots };
      await writeAtomic(this.statePath, JSON.stringify(this.persistentState));
      this.runtimeStatus = {
        state: 'active',
        sourceClient: 'antigravity',
        captureMode: 'automatic',
        autoRecordTurn: true,
        roots: roots.length,
        stagedTurns,
        lastScanAt: new Date().toISOString(),
      };
    } catch (error: unknown) {
      this.runtimeStatus = {
        state: 'degraded',
        sourceClient: 'antigravity',
        captureMode: 'automatic',
        autoRecordTurn: false,
        roots: roots.length,
        stagedTurns,
        lastScanAt: new Date().toISOString(),
        lastError: errorMessage(error),
      };
    }
  }

  private async persist(roots: Readonly<Record<string, RootCursor>>, initialized: boolean): Promise<void> {
    this.persistentState = { version: 1, initialized, roots };
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

export function defaultAntigravityStorageRoots(homeDir: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const override = env.UNIFIED_MPC_ANTIGRAVITY_STORAGE?.trim();
  if (override) return dedupePaths(override.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean));
  return [path.join(homeDir, '.gemini', 'antigravity')];
}

async function discoverAntigravityRoots(configured: readonly string[] | undefined): Promise<readonly string[]> {
  const candidates = configured ?? defaultAntigravityStorageRoots();
  const available: string[] = [];
  for (const candidate of dedupePaths(candidates)) {
    try {
      await access(path.join(candidate, SUMMARY_DATABASE_FILE));
      await access(path.join(candidate, 'brain'));
      const database = new DatabaseSync(path.join(candidate, SUMMARY_DATABASE_FILE), { readOnly: true });
      try { ensureSupportedSchema(database, candidate); } finally { database.close(); }
      available.push(path.resolve(candidate));
    } catch { /* unsupported/not installed */ }
  }
  return available;
}

function ensureSupportedSchema(database: DatabaseSync, root: string): void {
  const row = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_summaries'").get() as { name?: unknown } | undefined;
  if (row?.name !== 'conversation_summaries') throw new Error(`Unsupported Antigravity summary schema: ${root}`);
}

function readConversationSummaries(database: DatabaseSync): readonly ConversationSummary[] {
  const rows = database.prepare(`SELECT conversation_id, step_count, last_modified_time, workspace_uris, status, not_fully_idle, killed
    FROM conversation_summaries ORDER BY last_modified_time, conversation_id`).all() as Record<string, unknown>[];
  const summaries: ConversationSummary[] = [];
  for (const row of rows) {
    const conversationId = boundedString(row.conversation_id, 1, 256);
    const stepCount = validNonNegativeInteger(row.step_count);
    const lastModified = boundedString(row.last_modified_time, 1, 256);
    const projectRef = parseWorkspaceProjectRef(row.workspace_uris);
    if (conversationId === undefined || stepCount === undefined || lastModified === undefined || projectRef === undefined) continue;
    const idle = row.status === 'CASCADE_RUN_STATUS_IDLE' && Number(row.not_fully_idle) === 0 && Number(row.killed) === 0;
    summaries.push({ conversationId, stepCount, lastModified, projectRef, idle });
  }
  return summaries;
}

async function readCompletedTurns(root: string, conversationId: string): Promise<readonly ExtractedTurn[]> {
  const transcriptPath = path.join(root, 'brain', conversationId, TRANSCRIPT_RELATIVE_PATH);
  let info;
  try { info = await stat(transcriptPath); } catch (error: unknown) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
  if (!info.isFile()) return [];
  if (info.size > MAX_TRANSCRIPT_FILE_BYTES) throw new Error(`Antigravity transcript exceeds ${MAX_TRANSCRIPT_FILE_BYTES} bytes: ${conversationId}`);

  const events: TranscriptEvent[] = [];
  const lines = (await readFile(transcriptPath, 'utf8')).split(/\r?\n/);
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!isRecord(parsed)) continue;
    const stepIndex = validNonNegativeInteger(parsed.step_index);
    const source = boundedString(parsed.source, 1, 64);
    const type = boundedString(parsed.type, 1, 64);
    const status = boundedString(parsed.status, 1, 64);
    const createdAt = validIsoTimestamp(parsed.created_at);
    if (stepIndex === undefined || source === undefined || type === undefined || status === undefined || createdAt === undefined) continue;
    const content = boundedTranscriptText(parsed.content);
    const toolCalls = Array.isArray(parsed.tool_calls) ? parsed.tool_calls.length : 0;
    events.push({ stepIndex, source, type, status, createdAt, ...(content === undefined ? {} : { content }), toolCalls });
  }
  events.sort((a, b) => a.stepIndex - b.stepIndex || a.createdAt.localeCompare(b.createdAt));

  const turns: ExtractedTurn[] = [];
  let latestUser: { readonly step: number; readonly timestamp: string; readonly text: string } | undefined;
  let finalCandidate: { readonly step: number; readonly timestamp: string; readonly text: string } | undefined;
  const finalizeSegment = (): void => {
    if (latestUser === undefined || finalCandidate === undefined) return;
    if (Date.parse(finalCandidate.timestamp) < Date.parse(latestUser.timestamp)) return;
    turns.push({
      assistantStep: finalCandidate.step,
      assistantTimestamp: finalCandidate.timestamp,
      userStep: latestUser.step,
      userTimestamp: latestUser.timestamp,
      userMessage: latestUser.text,
      assistantMessage: finalCandidate.text,
    });
  };

  for (const event of events) {
    const isUser = event.source === 'USER_EXPLICIT' && event.type === 'USER_INPUT' && event.status === 'DONE' && event.content !== undefined;
    if (isUser) {
      finalizeSegment();
      latestUser = { step: event.stepIndex, timestamp: event.createdAt, text: event.content! };
      finalCandidate = undefined;
      continue;
    }
    const isFinalAssistant = latestUser !== undefined
      && event.source === 'MODEL'
      && event.type === 'PLANNER_RESPONSE'
      && event.status === 'DONE'
      && event.content !== undefined
      && event.toolCalls === 0;
    if (isFinalAssistant) finalCandidate = { step: event.stepIndex, timestamp: event.createdAt, text: event.content! };
  }
  finalizeSegment();
  return turns;
}

function toTranscript(rootKey: string, summary: ConversationSummary, turn: ExtractedTurn, sequence: number): CompletedTurnTranscript {
  const safeConversationId = stableId(summary.conversationId);
  return {
    version: 1,
    sessionId: `antigravity:${rootKey}:${safeConversationId}`,
    turnId: `antigravity:${rootKey}:${safeConversationId}:${turn.assistantStep}`,
    projectRef: summary.projectRef,
    sequence,
    userMessage: turn.userMessage,
    assistantMessage: turn.assistantMessage,
    userTimestamp: turn.userTimestamp,
    assistantTimestamp: turn.assistantTimestamp,
    sourceClient: 'antigravity',
    metadata: {
      antigravityConversationId: summary.conversationId,
      userStep: turn.userStep,
      assistantStep: turn.assistantStep,
    },
  };
}

function baselineCursor(summary: ConversationSummary): ConversationCursor {
  return {
    lastModified: summary.lastModified,
    lastAssistantStep: Math.max(-1, summary.stepCount - 1),
    stagedCount: 0,
    updatedAt: new Date().toISOString(),
  };
}

function parseWorkspaceProjectRef(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return undefined; }
  if (!Array.isArray(parsed)) return undefined;
  for (const entry of parsed) {
    if (typeof entry !== 'string' || !entry.startsWith('file:')) continue;
    try {
      const decoded = fileURLToPath(entry);
      if (decoded.trim().length > 0 && decoded.length <= 4_096) return decoded;
    } catch { /* ignore malformed URI */ }
  }
  return undefined;
}

function pruneConversationCursors(conversations: Readonly<Record<string, ConversationCursor>>): Readonly<Record<string, ConversationCursor>> {
  const entries = Object.entries(conversations);
  if (entries.length <= MAX_TRACKED_CONVERSATIONS_PER_ROOT) return conversations;
  return Object.fromEntries(entries.sort(([, a], [, b]) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, MAX_TRACKED_CONVERSATIONS_PER_ROOT));
}

async function readSourceState(filePath: string): Promise<PersistentSourceState> {
  try {
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    if (!isRecord(raw) || raw.version !== 1 || typeof raw.initialized !== 'boolean' || !isRecord(raw.roots)) throw new Error('invalid state');
    return raw as unknown as PersistentSourceState;
  } catch {
    return { version: 1, initialized: false, roots: {} };
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

function validIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return undefined;
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

function validNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
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

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
