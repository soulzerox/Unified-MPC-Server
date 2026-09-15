import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  stageTurnTranscript,
  type CompletedTurnTranscript,
} from '@unified-mpc/mcp-server';

const SOURCE_STATE_DIRECTORY = 'turn-sources';
const SOURCE_STATE_FILE = 'cline.json';
const SOURCE_LEASE_FILE = 'cline.lock';
const TASK_HISTORY_FILE = path.join('state', 'taskHistory.json');
const UI_MESSAGES_FILE = 'ui_messages.json';
const MAX_SOURCE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 60_000;
const MAX_TRACKED_TASKS_PER_ROOT = 512;
const DEFAULT_SCAN_INTERVAL_MS = 2_000;

interface ClineHistoryEntry {
  readonly id: string;
  readonly ulid?: string;
  readonly task?: string;
  readonly cwdOnTaskInitialization: string;
}

interface ClineUiMessage {
  readonly ts?: number;
  readonly type?: string;
  readonly say?: string;
  readonly text?: string;
  readonly files?: readonly unknown[];
  readonly images?: readonly unknown[];
}

interface ExtractedClineTurn {
  readonly completionTs: number;
  readonly userTs: number;
  readonly userMessage: string;
  readonly assistantMessage: string;
}

interface TaskCursor {
  readonly lastCompletionTs: number;
  readonly stagedCount: number;
  readonly updatedAt: string;
}

interface RootCursor {
  readonly tasks: Readonly<Record<string, TaskCursor>>;
}

interface PersistentSourceState {
  readonly version: 1;
  readonly initialized: boolean;
  readonly roots: Readonly<Record<string, RootCursor>>;
}

export interface ClineTurnTranscriptSourceStatus {
  readonly state: 'active' | 'degraded' | 'unavailable';
  readonly sourceClient: 'cline';
  readonly captureMode: 'automatic';
  readonly autoRecordTurn: boolean;
  readonly roots: number;
  readonly stagedTurns: number;
  readonly lastScanAt?: string;
  readonly lastError?: string;
}

type StageResult = Awaited<ReturnType<typeof stageTurnTranscript>>;

export interface ClineTurnTranscriptSourceOptions {
  readonly dataPath: string;
  readonly key: Uint8Array;
  readonly storageRoots?: readonly string[];
  readonly intervalMs?: number;
  readonly stage?: (turn: CompletedTurnTranscript) => Promise<StageResult>;
}

/**
 * Reads Cline's persisted task history instead of scraping its UI. Cline 4.x
 * legacy and next bundles both persist `state/taskHistory.json` plus per-task
 * `ui_messages.json`; a `say: completion_result` message is the stable
 * completed-turn boundary.
 *
 * The first successful scan establishes a baseline and intentionally does not
 * backfill old Cline history. Subsequent scans stage every newly completed
 * turn into the signed Unified MCP journal. Cursor state is durable, so turns
 * completed while Unified MCP is offline are replayed after restart.
 */
export class ClineTurnTranscriptSource {
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
  private runtimeStatus: ClineTurnTranscriptSourceStatus = {
    state: 'unavailable',
    sourceClient: 'cline',
    captureMode: 'automatic',
    autoRecordTurn: false,
    roots: 0,
    stagedTurns: 0,
  };

  public constructor(options: ClineTurnTranscriptSourceOptions) {
    if (options.key.byteLength !== 32) throw new Error('Cline turn transcript ingress key must be exactly 32 bytes');
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

  public status(): ClineTurnTranscriptSourceStatus {
    return { ...this.runtimeStatus };
  }

  public scan(): Promise<void> {
    if (this.scanPromise !== undefined) return this.scanPromise;
    this.scanPromise = this.scanInternal().finally(() => { this.scanPromise = undefined; });
    return this.scanPromise;
  }

  private async scanInternal(): Promise<void> {
    const roots = await discoverClineStorageRoots(this.configuredRoots);
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
        lastError: 'Another Unified MCP runtime owns the Cline transcript producer lease',
      };
      return;
    }

    const firstSuccessfulScan = !this.persistentState.initialized;
    let stagedTurns = this.runtimeStatus.stagedTurns;
    const mutableRoots: Record<string, RootCursor> = { ...this.persistentState.roots };
    try {
      for (const root of roots) {
        const rootKey = sourceRootKey(root);
        const previousRoot = mutableRoots[rootKey] ?? { tasks: {} };
        const taskCursors: Record<string, TaskCursor> = { ...previousRoot.tasks };
        const history = await readTaskHistory(root);

        for (const item of history) {
          const turns = await readCompletedTurns(root, item);
          const previous = taskCursors[item.id];
          if (firstSuccessfulScan) {
            taskCursors[item.id] = cursorAfterBaseline(turns);
            continue;
          }

          let cursor = previous ?? { lastCompletionTs: 0, stagedCount: 0, updatedAt: new Date(0).toISOString() };
          for (const turn of turns) {
            if (turn.completionTs <= cursor.lastCompletionTs) continue;
            const sequence = cursor.stagedCount + 1;
            const transcript = toTranscript(rootKey, item, turn, sequence);
            const staged = await this.stage(transcript);
            if (!staged.ok) throw new Error(staged.error.message);
            cursor = {
              lastCompletionTs: turn.completionTs,
              stagedCount: sequence,
              updatedAt: new Date().toISOString(),
            };
            taskCursors[item.id] = cursor;
            stagedTurns += staged.value.duplicate ? 0 : 1;
            await this.persist({ ...mutableRoots, [rootKey]: { tasks: pruneTaskCursors(taskCursors) } }, true);
          }
          taskCursors[item.id] = cursor;
        }
        mutableRoots[rootKey] = { tasks: pruneTaskCursors(taskCursors) };
      }

      this.persistentState = {
        version: 1,
        initialized: true,
        roots: mutableRoots,
      };
      await writeAtomic(this.statePath, JSON.stringify(this.persistentState));
      this.runtimeStatus = {
        state: 'active',
        sourceClient: 'cline',
        captureMode: 'automatic',
        autoRecordTurn: true,
        roots: roots.length,
        stagedTurns,
        lastScanAt: new Date().toISOString(),
      };
    } catch (error: unknown) {
      this.runtimeStatus = {
        state: 'degraded',
        sourceClient: 'cline',
        captureMode: 'automatic',
        autoRecordTurn: false,
        roots: roots.length,
        stagedTurns,
        lastScanAt: new Date().toISOString(),
        lastError: errorMessage(error),
      };
    }
  }

  private async ensureProducerLease(): Promise<boolean> {
    if (this.ownsProducerLease) return true;
    await mkdir(path.dirname(this.leasePath), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await writeFile(this.leasePath, JSON.stringify({
          version: 1,
          pid: process.pid,
          token: this.leaseToken,
          createdAt: new Date().toISOString(),
        }), { flag: 'wx', mode: 0o600 });
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

  private async persist(roots: Readonly<Record<string, RootCursor>>, initialized: boolean): Promise<void> {
    this.persistentState = { version: 1, initialized, roots };
    await writeAtomic(this.statePath, JSON.stringify(this.persistentState));
  }
}

export function defaultClineStorageRoots(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const override = env.UNIFIED_MPC_CLINE_GLOBAL_STORAGE?.trim();
  if (override) return dedupePaths(override.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean));

  const relative = path.join('User', 'globalStorage', 'saoudrizwan.claude-dev');
  if (platform === 'win32') {
    const appData = env.APPDATA?.trim();
    return appData ? dedupePaths([
      path.join(appData, 'Code', relative),
      path.join(appData, 'Code - Insiders', relative),
      path.join(appData, 'VSCodium', relative),
    ]) : [];
  }
  if (platform === 'darwin') {
    const base = path.join(homeDir, 'Library', 'Application Support');
    return dedupePaths([
      path.join(base, 'Code', relative),
      path.join(base, 'Code - Insiders', relative),
      path.join(base, 'VSCodium', relative),
    ]);
  }
  return dedupePaths([
    path.join(env.XDG_CONFIG_HOME?.trim() || path.join(homeDir, '.config'), 'Code', relative),
    path.join(env.XDG_CONFIG_HOME?.trim() || path.join(homeDir, '.config'), 'Code - Insiders', relative),
    path.join(env.XDG_CONFIG_HOME?.trim() || path.join(homeDir, '.config'), 'VSCodium', relative),
  ]);
}

async function discoverClineStorageRoots(configured: readonly string[] | undefined): Promise<readonly string[]> {
  const candidates = configured ?? defaultClineStorageRoots();
  const available: string[] = [];
  for (const candidate of dedupePaths(candidates)) {
    try {
      await access(path.join(candidate, TASK_HISTORY_FILE));
      await access(path.join(candidate, 'tasks'));
      available.push(path.resolve(candidate));
    } catch { /* unsupported or not installed */ }
  }
  return available;
}

async function readTaskHistory(root: string): Promise<readonly ClineHistoryEntry[]> {
  const raw = await readBoundedJson(path.join(root, TASK_HISTORY_FILE));
  if (!Array.isArray(raw)) throw new Error(`Cline task history is not an array: ${root}`);
  const result: ClineHistoryEntry[] = [];
  for (const value of raw) {
    if (!isRecord(value)) continue;
    const id = boundedString(value.id, 1, 256);
    const cwd = boundedString(value.cwdOnTaskInitialization, 1, 4_096);
    if (id === undefined || cwd === undefined) continue;
    const ulid = boundedString(value.ulid, 1, 256);
    const task = boundedString(value.task, 1, MAX_TRANSCRIPT_BYTES);
    result.push({ id, cwdOnTaskInitialization: cwd, ...(ulid === undefined ? {} : { ulid }), ...(task === undefined ? {} : { task }) });
  }
  return result;
}

async function readCompletedTurns(root: string, task: ClineHistoryEntry): Promise<readonly ExtractedClineTurn[]> {
  const filePath = path.join(root, 'tasks', task.id, UI_MESSAGES_FILE);
  let raw: unknown;
  try { raw = await readBoundedJson(filePath); } catch (error: unknown) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
  if (!Array.isArray(raw)) throw new Error(`Cline UI messages are not an array for task ${task.id}`);

  const turns: ExtractedClineTurn[] = [];
  let latestUser: { readonly ts: number; readonly text: string } | undefined;
  for (const value of raw) {
    if (!isRecord(value)) continue;
    const message = value as ClineUiMessage;
    const ts = validEpochMs(message.ts);
    if (ts === undefined) continue;
    if (message.type === 'say' && isUserMessageKind(message.say)) {
      const text = extractClineUserText(message);
      if (text !== undefined) latestUser = { ts, text };
      continue;
    }
    if (message.type !== 'say' || message.say !== 'completion_result') continue;
    const assistant = boundedTranscriptText(message.text);
    if (assistant === undefined) continue;
    const user = latestUser ?? (turns.length === 0 && task.task
      ? { ts: Math.max(0, ts - 1), text: boundedTranscriptText(task.task) ?? task.task }
      : undefined);
    if (user === undefined) throw new Error(`Cline completion ${task.id}/${ts} has no preceding user message`);
    turns.push({ completionTs: ts, userTs: Math.min(user.ts, ts), userMessage: user.text, assistantMessage: assistant });
    latestUser = undefined;
  }
  return turns;
}

function toTranscript(rootKey: string, task: ClineHistoryEntry, turn: ExtractedClineTurn, sequence: number): CompletedTurnTranscript {
  const safeTaskId = task.id.length <= 96 ? task.id : createHash('sha256').update(task.id).digest('hex');
  return {
    version: 1,
    sessionId: `cline:${rootKey}:${safeTaskId}`,
    turnId: `cline:${rootKey}:${safeTaskId}:${turn.completionTs}`,
    projectRef: task.cwdOnTaskInitialization,
    sequence,
    userMessage: turn.userMessage,
    assistantMessage: turn.assistantMessage,
    userTimestamp: new Date(turn.userTs).toISOString(),
    assistantTimestamp: new Date(turn.completionTs).toISOString(),
    sourceClient: 'cline',
    metadata: {
      clineTaskId: task.id,
      ...(task.ulid === undefined ? {} : { clineUlid: task.ulid }),
      completionTimestamp: turn.completionTs,
    },
  };
}

function cursorAfterBaseline(turns: readonly ExtractedClineTurn[]): TaskCursor {
  const last = turns.at(-1);
  return {
    lastCompletionTs: last?.completionTs ?? 0,
    stagedCount: 0,
    updatedAt: new Date().toISOString(),
  };
}

function pruneTaskCursors(tasks: Readonly<Record<string, TaskCursor>>): Readonly<Record<string, TaskCursor>> {
  const entries = Object.entries(tasks);
  if (entries.length <= MAX_TRACKED_TASKS_PER_ROOT) return tasks;
  return Object.fromEntries(entries
    .sort(([, a], [, b]) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, MAX_TRACKED_TASKS_PER_ROOT));
}

async function readBoundedJson(filePath: string): Promise<unknown> {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error(`Expected a file: ${filePath}`);
  if (info.size > MAX_SOURCE_FILE_BYTES) throw new Error(`Cline source file exceeds ${MAX_SOURCE_FILE_BYTES} bytes: ${filePath}`);
  return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
}

async function readSourceState(filePath: string): Promise<PersistentSourceState> {
  try {
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    if (!isRecord(raw) || raw.version !== 1 || typeof raw.initialized !== 'boolean' || !isRecord(raw.roots)) throw new Error('invalid state');
    return raw as unknown as PersistentSourceState;
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      // Corrupt source state must not cause historical backfill. Establish a new baseline instead.
    }
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

function isUserMessageKind(value: unknown): boolean {
  return value === 'task' || value === 'user_feedback' || value === 'user_feedback_diff';
}

function extractClineUserText(message: ClineUiMessage): string | undefined {
  const text = boundedTranscriptText(message.text);
  if (text !== undefined) return text;
  const attachmentCount = (Array.isArray(message.files) ? message.files.length : 0) + (Array.isArray(message.images) ? message.images.length : 0);
  return attachmentCount > 0 ? '[Cline user feedback contained attachments without text]' : undefined;
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

interface ProducerLease {
  readonly version: 1;
  readonly pid: number;
  readonly token: string;
}

async function readProducerLease(filePath: string): Promise<ProducerLease | null> {
  try {
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    if (!isRecord(raw) || raw.version !== 1 || !Number.isSafeInteger(raw.pid) || (raw.pid as number) <= 0 || typeof raw.token !== 'string') return null;
    return { version: 1, pid: raw.pid as number, token: raw.token };
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM';
  }
}

function validEpochMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000 ? value : undefined;
}

function boundedString(value: unknown, min: number, max: number): string | undefined {
  return typeof value === 'string' && value.trim().length >= min && value.length <= max ? value : undefined;
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
