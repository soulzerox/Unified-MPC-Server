import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type Result } from '@unified-mpc/domain';

const TURN_INGRESS_KEY_FILE = '.turn-ingress-key';
const TURN_JOURNAL_DIRECTORY = 'turn-journal';
const MAX_MESSAGE_BYTES = 65_536;
const MAX_METADATA_BYTES = 16_384;
const MAX_ENVELOPE_BYTES = 160 * 1024;
const MAX_PENDING_TURNS = 512;
const MAX_RECONCILE_BATCH = 100;
const MAX_ID_LENGTH = 256;
const MAX_PROJECT_REF_LENGTH = 4_096;
const MAX_SOURCE_CLIENT_LENGTH = 128;

export interface CompletedTurnTranscript {
  readonly version: 1;
  readonly sessionId: string;
  readonly turnId: string;
  readonly projectRef: string;
  readonly sequence: number;
  readonly userMessage: string;
  readonly assistantMessage: string;
  readonly userTimestamp: string;
  readonly assistantTimestamp: string;
  readonly sourceClient: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface SignedTurnEnvelope {
  readonly payload: CompletedTurnTranscript;
  readonly signature: string;
}

interface TurnAck {
  readonly version: 1;
  readonly sessionId: string;
  readonly turnId: string;
  readonly sequence: number;
  readonly projectId: string;
  readonly sourceClient: string;
  readonly acknowledgedAt: string;
  readonly replayed: boolean;
}

interface RetryState {
  readonly attempts: number;
  readonly updatedAt: string;
  readonly lastError?: string;
}

interface PersistentSupervisorState {
  readonly version: 1;
  readonly replayCount: number;
  readonly rejectedTurns: number;
  readonly lastRecordedTurnId?: string;
  readonly lastReconciliationAt?: string;
  readonly lastError?: string;
}

export interface TurnTranscriptProjectBinding {
  readonly projectId: string;
  readonly rootPath: string;
}

export interface TurnTranscriptPersistResult {
  readonly ok: boolean;
  readonly recorded?: number;
  readonly skipped?: number;
  readonly error?: string;
}

export interface TurnTranscriptSupervisorOptions {
  readonly dataPath: string;
  readonly key: Uint8Array;
  readonly resolveProject: (projectRef: string) => Promise<TurnTranscriptProjectBinding | null>;
  readonly persist: (
    turn: CompletedTurnTranscript & { readonly projectId: string; readonly projectRoot: string },
    signal?: AbortSignal,
  ) => Promise<TurnTranscriptPersistResult>;
  readonly intervalMs?: number;
  readonly maxBatchSize?: number;
}

export interface TurnTranscriptSourceRuntimeStatus {
  readonly sourceClient: string;
  readonly state: 'active' | 'degraded' | 'unavailable' | 'standby';
  readonly captureMode: 'automatic' | 'policy-assisted' | 'callback-required' | 'unavailable';
  readonly autoRecordTurn: boolean;
  readonly roots: number;
  readonly stagedTurns: number;
  readonly lastScanAt?: string;
  readonly lastError?: string;
}

export interface TurnTranscriptRuntimeStatus {
  readonly state: 'connected' | 'degraded' | 'offline';
  /** True only when at least one real automatic host transcript producer is currently available. */
  readonly autoRecordTurn: boolean;
  readonly approvalMode: 'trusted-memory-only';
  /** Per-host truth source. ChatGPT Web is policy-assisted unless its host supplies a transcript callback. */
  readonly sources?: readonly TurnTranscriptSourceRuntimeStatus[];
  /** Compatibility projection of the first active automatic source. */
  readonly sourceClient?: string;
  readonly sourceState?: 'active' | 'degraded' | 'unavailable' | 'standby';
  readonly sourceRoots?: number;
  readonly sourceLastScanAt?: string;
  readonly sourceLastError?: string;
  readonly pendingTurns: number;
  readonly replayCount: number;
  readonly rejectedTurns: number;
  readonly missingSequences: readonly number[];
  readonly lastRecordedTurnId?: string;
  readonly lastReconciliationAt?: string;
  readonly lastError?: string;
}

export async function loadOrCreateTurnIngressKey(dataPath: string): Promise<Buffer> {
  const keyPath = path.join(dataPath, TURN_INGRESS_KEY_FILE);
  await mkdir(dataPath, { recursive: true });
  try {
    const existing = await readFile(keyPath);
    if (existing.byteLength !== 32) throw new Error('Turn ingress key must be exactly 32 bytes');
    return existing;
  } catch (error: unknown) {
    if (!isMissingFileError(error)) throw error;
  }
  const generated = randomBytes(32);
  try {
    await writeFile(keyPath, generated, { flag: 'wx', mode: 0o600 });
    return generated;
  } catch (error: unknown) {
    if (!isAlreadyExistsError(error)) throw error;
    const existing = await readFile(keyPath);
    if (existing.byteLength !== 32) throw new Error('Turn ingress key must be exactly 32 bytes');
    await chmod(keyPath, 0o600).catch(() => undefined);
    return existing;
  }
}

export async function stageTurnTranscript(
  dataPath: string,
  key: Uint8Array,
  transcript: CompletedTurnTranscript,
): Promise<Result<{ readonly duplicate: boolean; readonly acknowledged: boolean; readonly entryId: string }>> {
  const validated = validateTranscript(transcript);
  if (!validated.ok) return validated;
  if (key.byteLength !== 32) return err(appError('INVALID_INPUT', 'Turn ingress key must be exactly 32 bytes'));

  const directories = journalDirectories(dataPath);
  await ensureJournalDirectories(directories);
  const entryId = turnEntryId(transcript.sessionId, transcript.turnId);
  const ackPath = path.join(directories.acked, `${entryId}.json`);
  if (await fileExists(ackPath)) return ok({ duplicate: true, acknowledged: true, entryId });

  const incomingPath = path.join(directories.incoming, `${entryId}.json`);
  const envelope = signEnvelope(transcript, key);
  const encoded = encodeEnvelope(envelope);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_ENVELOPE_BYTES) {
    return err(appError('INVALID_INPUT', `Turn transcript envelope exceeds ${MAX_ENVELOPE_BYTES} bytes`));
  }

  try {
    const existing = await readFile(incomingPath, 'utf8');
    if (existing === encoded) return ok({ duplicate: true, acknowledged: false, entryId });
    return err(appError('CONFLICT', 'A different transcript is already staged for this session/turn id'));
  } catch (error: unknown) {
    if (!isMissingFileError(error)) return err(appError('INTERNAL_ERROR', `Failed to inspect staged turn: ${errorMessage(error)}`, true));
  }

  const pending = (await safeJsonFileList(directories.incoming)).length;
  if (pending >= MAX_PENDING_TURNS) return err(appError('CONFLICT', `Turn transcript spool is full (${MAX_PENDING_TURNS} pending turns)`, true));

  try {
    await writeAtomic(incomingPath, encoded);
    return ok({ duplicate: false, acknowledged: false, entryId });
  } catch (error: unknown) {
    return err(appError('INTERNAL_ERROR', `Failed to stage turn transcript: ${errorMessage(error)}`, true));
  }
}

export class TurnTranscriptSupervisor {
  private readonly dataPath: string;
  private readonly key: Buffer;
  private readonly resolveProject: TurnTranscriptSupervisorOptions['resolveProject'];
  private readonly persist: TurnTranscriptSupervisorOptions['persist'];
  private readonly intervalMs: number;
  private readonly maxBatchSize: number;
  private timer: NodeJS.Timeout | undefined;
  private reconcilePromise: Promise<void> | undefined;
  private runtimeStatus: TurnTranscriptRuntimeStatus = {
    state: 'offline',
    autoRecordTurn: false,
    approvalMode: 'trusted-memory-only',
    pendingTurns: 0,
    replayCount: 0,
    rejectedTurns: 0,
    missingSequences: [],
  };

  public constructor(options: TurnTranscriptSupervisorOptions) {
    if (options.key.byteLength !== 32) throw new Error('Turn ingress key must be exactly 32 bytes');
    this.dataPath = options.dataPath;
    this.key = Buffer.from(options.key);
    this.resolveProject = options.resolveProject;
    this.persist = options.persist;
    this.intervalMs = normalizePositiveInteger(options.intervalMs, 2_000, 250, 60_000);
    this.maxBatchSize = normalizePositiveInteger(options.maxBatchSize, MAX_RECONCILE_BATCH, 1, MAX_RECONCILE_BATCH);
  }

  public start(): void {
    if (this.timer !== undefined) return;
    void this.reconcile();
    this.timer = setInterval(() => { void this.reconcile(); }, this.intervalMs);
    this.timer.unref?.();
  }

  public async close(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.reconcilePromise?.catch(() => undefined);
  }

  public status(): TurnTranscriptRuntimeStatus {
    return { ...this.runtimeStatus, missingSequences: [...this.runtimeStatus.missingSequences] };
  }

  public reconcile(signal?: AbortSignal): Promise<void> {
    if (this.reconcilePromise !== undefined) return this.reconcilePromise;
    this.reconcilePromise = this.reconcileInternal(signal).finally(() => {
      this.reconcilePromise = undefined;
    });
    return this.reconcilePromise;
  }

  private async reconcileInternal(signal?: AbortSignal): Promise<void> {
    const directories = journalDirectories(this.dataPath);
    await ensureJournalDirectories(directories);
    const persistent = await readPersistentState(directories.stateFile);
    let replayCount = persistent.replayCount;
    let rejectedTurns = persistent.rejectedTurns;
    let lastRecordedTurnId = persistent.lastRecordedTurnId;
    let lastError: string | undefined;
    let failed = false;

    const files = (await safeJsonFileList(directories.incoming)).slice(0, this.maxBatchSize);
    for (const fileName of files) {
      if (signal?.aborted === true) break;
      const incomingPath = path.join(directories.incoming, fileName);
      const read = await readAndVerifyEnvelope(incomingPath, this.key);
      if (!read.ok) {
        rejectedTurns += 1;
        lastError = read.error;
        failed = true;
        await quarantineTurn(incomingPath, path.join(directories.rejected, fileName), read.error);
        await unlink(path.join(directories.attempts, fileName)).catch(() => undefined);
        continue;
      }

      const project = await this.resolveProject(read.payload.projectRef).catch(() => null);
      if (project === null || !projectBindingMatches(read.payload.projectRef, project)) {
        const reason = `Transcript project binding is not trusted: ${read.payload.projectRef}`;
        rejectedTurns += 1;
        lastError = reason;
        failed = true;
        await quarantineTurn(incomingPath, path.join(directories.rejected, fileName), reason);
        await unlink(path.join(directories.attempts, fileName)).catch(() => undefined);
        continue;
      }

      const retryPath = path.join(directories.attempts, fileName);
      const retry = await readRetryState(retryPath);
      let persisted: TurnTranscriptPersistResult;
      try {
        persisted = await this.persist({ ...read.payload, projectId: project.projectId, projectRoot: project.rootPath }, signal);
      } catch (error: unknown) {
        persisted = { ok: false, error: errorMessage(error) };
      }
      if (!persisted.ok) {
        failed = true;
        lastError = persisted.error ?? 'Turn persistence failed';
        await writeAtomic(retryPath, JSON.stringify({ attempts: retry.attempts + 1, updatedAt: new Date().toISOString(), lastError } satisfies RetryState));
        continue;
      }

      const replayed = retry.attempts > 0;
      if (replayed) replayCount += 1;
      const ack: TurnAck = {
        version: 1,
        sessionId: read.payload.sessionId,
        turnId: read.payload.turnId,
        sequence: read.payload.sequence,
        projectId: project.projectId,
        sourceClient: read.payload.sourceClient,
        acknowledgedAt: new Date().toISOString(),
        replayed,
      };
      await writeAtomic(path.join(directories.acked, fileName), JSON.stringify(ack));
      await unlink(incomingPath).catch(() => undefined);
      await unlink(retryPath).catch(() => undefined);
      lastRecordedTurnId = read.payload.turnId;
    }

    const pendingTurns = (await safeJsonFileList(directories.incoming)).length;
    const missingSequences = await detectMissingSequences(directories.acked, directories.incoming, this.key);
    if (missingSequences.length > 0) failed = true;
    const lastReconciliationAt = new Date().toISOString();
    const nextPersistent: PersistentSupervisorState = {
      version: 1,
      replayCount,
      rejectedTurns,
      ...(lastRecordedTurnId === undefined ? {} : { lastRecordedTurnId }),
      lastReconciliationAt,
      ...(lastError === undefined ? {} : { lastError }),
    };
    await writeAtomic(directories.stateFile, JSON.stringify(nextPersistent));
    this.runtimeStatus = {
      state: failed ? 'degraded' : 'connected',
      autoRecordTurn: false,
      approvalMode: 'trusted-memory-only',
      pendingTurns,
      replayCount,
      rejectedTurns,
      missingSequences,
      ...(lastRecordedTurnId === undefined ? {} : { lastRecordedTurnId }),
      lastReconciliationAt,
      ...(lastError === undefined ? {} : { lastError }),
    };
  }
}

function validateTranscript(input: CompletedTurnTranscript): Result<CompletedTurnTranscript> {
  if (input.version !== 1) return err(appError('INVALID_INPUT', 'Unsupported turn transcript version'));
  if (!boundedText(input.sessionId, 1, MAX_ID_LENGTH)) return err(appError('INVALID_INPUT', 'sessionId is required and must be bounded'));
  if (!boundedText(input.turnId, 1, MAX_ID_LENGTH)) return err(appError('INVALID_INPUT', 'turnId is required and must be bounded'));
  if (!boundedText(input.projectRef, 1, MAX_PROJECT_REF_LENGTH)) return err(appError('INVALID_INPUT', 'projectRef is required and must be bounded'));
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) return err(appError('INVALID_INPUT', 'sequence must be a positive safe integer'));
  if (!boundedUtf8(input.userMessage, 1, MAX_MESSAGE_BYTES)) return err(appError('INVALID_INPUT', `userMessage must be 1-${MAX_MESSAGE_BYTES} UTF-8 bytes`));
  if (!boundedUtf8(input.assistantMessage, 1, MAX_MESSAGE_BYTES)) return err(appError('INVALID_INPUT', `assistantMessage must be 1-${MAX_MESSAGE_BYTES} UTF-8 bytes`));
  if (!boundedText(input.sourceClient, 1, MAX_SOURCE_CLIENT_LENGTH)) return err(appError('INVALID_INPUT', 'sourceClient is required and must be bounded'));
  if (!validTimestamp(input.userTimestamp) || !validTimestamp(input.assistantTimestamp)) return err(appError('INVALID_INPUT', 'Turn transcript timestamps must be valid ISO-8601 values'));
  if (Date.parse(input.assistantTimestamp) < Date.parse(input.userTimestamp)) return err(appError('INVALID_INPUT', 'assistantTimestamp cannot precede userTimestamp'));
  if (input.metadata !== undefined) {
    let encoded: string;
    try { encoded = JSON.stringify(input.metadata); } catch { return err(appError('INVALID_INPUT', 'metadata must be JSON serializable')); }
    if (Buffer.byteLength(encoded, 'utf8') > MAX_METADATA_BYTES) return err(appError('INVALID_INPUT', `metadata exceeds ${MAX_METADATA_BYTES} bytes`));
  }
  return ok(input);
}

function signEnvelope(payload: CompletedTurnTranscript, key: Uint8Array): SignedTurnEnvelope {
  const canonical = JSON.stringify(payload);
  return { payload, signature: createHmac('sha256', key).update(canonical).digest('hex') };
}

function encodeEnvelope(envelope: SignedTurnEnvelope): string {
  return JSON.stringify(envelope);
}

async function readAndVerifyEnvelope(filePath: string, key: Uint8Array): Promise<{ readonly ok: true; readonly payload: CompletedTurnTranscript } | { readonly ok: false; readonly error: string }> {
  try {
    const raw = await readFile(filePath, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_ENVELOPE_BYTES) return { ok: false, error: 'Turn transcript envelope exceeds the maximum payload size' };
    const parsed = JSON.parse(raw) as Partial<SignedTurnEnvelope>;
    if (!parsed.payload || typeof parsed.signature !== 'string') return { ok: false, error: 'Turn transcript envelope is malformed' };
    const validation = validateTranscript(parsed.payload as CompletedTurnTranscript);
    if (!validation.ok) return { ok: false, error: validation.error.message };
    const expected = signEnvelope(validation.value, key).signature;
    const supplied = Buffer.from(parsed.signature, 'hex');
    const expectedBytes = Buffer.from(expected, 'hex');
    if (supplied.byteLength !== expectedBytes.byteLength || !timingSafeEqual(supplied, expectedBytes)) {
      return { ok: false, error: 'Turn transcript signature verification failed' };
    }
    return { ok: true, payload: validation.value };
  } catch (error: unknown) {
    return { ok: false, error: `Failed to read turn transcript: ${errorMessage(error)}` };
  }
}

function journalDirectories(dataPath: string): {
  readonly root: string;
  readonly incoming: string;
  readonly acked: string;
  readonly rejected: string;
  readonly attempts: string;
  readonly stateFile: string;
} {
  const root = path.join(dataPath, TURN_JOURNAL_DIRECTORY);
  return {
    root,
    incoming: path.join(root, 'incoming'),
    acked: path.join(root, 'acked'),
    rejected: path.join(root, 'rejected'),
    attempts: path.join(root, 'attempts'),
    stateFile: path.join(root, 'runtime-state.json'),
  };
}

async function ensureJournalDirectories(directories: ReturnType<typeof journalDirectories>): Promise<void> {
  await Promise.all([
    mkdir(directories.incoming, { recursive: true }),
    mkdir(directories.acked, { recursive: true }),
    mkdir(directories.rejected, { recursive: true }),
    mkdir(directories.attempts, { recursive: true }),
  ]);
}

function turnEntryId(sessionId: string, turnId: string): string {
  return createHash('sha256').update(JSON.stringify(['turn-spool-v1', sessionId, turnId])).digest('hex');
}

async function quarantineTurn(source: string, destination: string, reason: string): Promise<void> {
  let envelope: unknown = null;
  try { envelope = JSON.parse(await readFile(source, 'utf8')); } catch { envelope = null; }
  await writeAtomic(destination, JSON.stringify({ reason, rejectedAt: new Date().toISOString(), envelope }));
  await unlink(source).catch(() => undefined);
}

async function readRetryState(filePath: string): Promise<RetryState> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<RetryState>;
    return {
      attempts: Number.isSafeInteger(parsed.attempts) && (parsed.attempts ?? 0) >= 0 ? parsed.attempts! : 0,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
      ...(typeof parsed.lastError === 'string' ? { lastError: parsed.lastError } : {}),
    };
  } catch {
    return { attempts: 0, updatedAt: new Date(0).toISOString() };
  }
}

async function readPersistentState(filePath: string): Promise<PersistentSupervisorState> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<PersistentSupervisorState>;
    return {
      version: 1,
      replayCount: safeNonNegativeInteger(parsed.replayCount),
      rejectedTurns: safeNonNegativeInteger(parsed.rejectedTurns),
      ...(typeof parsed.lastRecordedTurnId === 'string' ? { lastRecordedTurnId: parsed.lastRecordedTurnId } : {}),
      ...(typeof parsed.lastReconciliationAt === 'string' ? { lastReconciliationAt: parsed.lastReconciliationAt } : {}),
      ...(typeof parsed.lastError === 'string' ? { lastError: parsed.lastError } : {}),
    };
  } catch {
    return { version: 1, replayCount: 0, rejectedTurns: 0 };
  }
}

async function detectMissingSequences(ackedDirectory: string, incomingDirectory: string, key: Uint8Array): Promise<readonly number[]> {
  const sessions = new Map<string, Set<number>>();
  for (const fileName of await safeJsonFileList(ackedDirectory)) {
    try {
      const ack = JSON.parse(await readFile(path.join(ackedDirectory, fileName), 'utf8')) as Partial<TurnAck>;
      if (typeof ack.sessionId !== 'string' || !Number.isSafeInteger(ack.sequence) || (ack.sequence ?? 0) < 1) continue;
      addSequence(sessions, ack.sessionId, ack.sequence!);
    } catch { /* ignore malformed internal evidence; status remains conservative */ }
  }
  for (const fileName of await safeJsonFileList(incomingDirectory)) {
    const read = await readAndVerifyEnvelope(path.join(incomingDirectory, fileName), key);
    if (read.ok) addSequence(sessions, read.payload.sessionId, read.payload.sequence);
  }
  const missing = new Set<number>();
  for (const sequences of sessions.values()) {
    if (sequences.size < 2) continue;
    const sorted = [...sequences].sort((a, b) => a - b);
    for (let value = sorted[0]!; value < sorted[sorted.length - 1]!; value += 1) {
      if (!sequences.has(value)) missing.add(value);
    }
  }
  return [...missing].sort((a, b) => a - b);
}

function addSequence(sessions: Map<string, Set<number>>, sessionId: string, sequence: number): void {
  const existing = sessions.get(sessionId);
  if (existing === undefined) sessions.set(sessionId, new Set([sequence]));
  else existing.add(sequence);
}

function projectBindingMatches(projectRef: string, project: TurnTranscriptProjectBinding): boolean {
  const normalizedRef = normalizeBinding(projectRef);
  return normalizedRef === normalizeBinding(project.projectId) || normalizedRef === normalizeBinding(project.rootPath);
}

function normalizeBinding(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
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

async function safeJsonFileList(directory: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try { return (await stat(filePath)).isFile(); } catch { return false; }
}

function boundedUtf8(value: unknown, minBytes: number, maxBytes: number): value is string {
  if (typeof value !== 'string') return false;
  const size = Buffer.byteLength(value, 'utf8');
  return size >= minBytes && size <= maxBytes;
}

function boundedText(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.trim().length >= min && value.length <= max;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function safeNonNegativeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}

function normalizePositiveInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value === undefined || value < min || value > max) return fallback;
  return value;
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
