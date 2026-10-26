import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  appError,
  classifyWorkspaceSourceEvidence,
  err,
  ok,
  type Result,
  type WorkspaceSourceEvidenceIdentity,
} from '@unified-mpc/domain';
import {
  resolveThaiRagWorkspaceNamespace,
  type CanonicalWorkspaceId,
} from './canonical-workspace.js';

/**
 * Why a workspace's last admission pass is trustworthy.
 *
 * `unchanged` means the pass completed and the provider reported no changed
 * files; `changed` means it published an updated lexical generation. Both are
 * successful verifications: the source identity, not the indexed-file count,
 * is what makes a later admission idempotent. `degraded` records a completed
 * lexical generation while an optional channel (vectors) was unavailable.
 */
export type ThaiRagVerificationOutcome = 'unchanged' | 'changed' | 'degraded';

export interface ThaiRagWorkspaceVerificationInput {
  readonly workspaceId: string;
  readonly sourceIdentity: WorkspaceSourceEvidenceIdentity;
  readonly outcome: ThaiRagVerificationOutcome;
  readonly providerStatus?: string;
  readonly indexedFiles: number;
  readonly skippedFiles: number;
  readonly totalFiles: number;
  readonly sourceSnapshotId?: string;
  readonly generationId?: string;
  readonly providerJobId?: string;
}

export interface ThaiRagWorkspaceVerificationRecord {
  readonly workspaceId: CanonicalWorkspaceId;
  readonly sourceIdentity: WorkspaceSourceEvidenceIdentity;
  readonly verifiedAt: string;
  readonly outcome: ThaiRagVerificationOutcome;
  readonly providerStatus?: string;
  readonly indexedFiles: number;
  readonly skippedFiles: number;
  readonly totalFiles: number;
  readonly sourceSnapshotId?: string;
  readonly generationId?: string;
  readonly providerJobId?: string;
}

interface StoredVerification {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly sourceIdentity: WorkspaceSourceEvidenceIdentity;
  readonly verifiedAt: string;
  readonly outcome: ThaiRagVerificationOutcome;
  readonly providerStatus?: string;
  readonly indexedFiles: number;
  readonly skippedFiles: number;
  readonly totalFiles: number;
  readonly sourceSnapshotId?: string;
  readonly generationId?: string;
  readonly providerJobId?: string;
}

/**
 * Durable proof that a workspace's source identity was admitted successfully.
 *
 * Issue #422: every new MCP child started with an empty in-memory pending set,
 * so a completed verification was forgotten across restarts and each admission
 * re-ran the full workspace index. This store keeps the verified source
 * identity on disk under the workspace's own provider namespace, so an
 * unchanged workspace is idempotent across process restarts.
 */
export class ThaiRagWorkspaceVerificationStore {
  private readonly now: () => Date;

  public constructor(
    private readonly dataRoot: string,
    options: { readonly now?: () => Date } = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
  }

  public async get(workspaceId: string): Promise<Result<ThaiRagWorkspaceVerificationRecord | null>> {
    const namespace = resolveThaiRagWorkspaceNamespace(this.dataRoot, workspaceId);
    if (!namespace.ok) return namespace;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(verificationPath(namespace.value.root), 'utf8'));
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') return ok(null);
      // A corrupt/partial verification record must never authorize skipping a
      // real verification pass: treat it as absent and let admission re-prove
      // the source identity.
      return ok(null);
    }
    const stored = parseStoredVerification(parsed, namespace.value.workspaceId);
    return stored === null ? ok(null) : ok(withWorkspaceId(stored, namespace.value.workspaceId));
  }

  public async isFresh(
    workspaceId: string,
    sourceIdentity: WorkspaceSourceEvidenceIdentity,
  ): Promise<Result<boolean>> {
    const current = await this.get(workspaceId);
    if (!current.ok) return current;
    if (current.value === null) return ok(false);
    return ok(classifyWorkspaceSourceEvidence(current.value.sourceIdentity, sourceIdentity) === 'fresh');
  }

  public async record(input: ThaiRagWorkspaceVerificationInput): Promise<Result<ThaiRagWorkspaceVerificationRecord>> {
    const namespace = resolveThaiRagWorkspaceNamespace(this.dataRoot, input.workspaceId);
    if (!namespace.ok) return namespace;
    if (!isSourceIdentity(input.sourceIdentity)
      || !isOutcome(input.outcome)
      || !isCounter(input.indexedFiles)
      || !isCounter(input.skippedFiles)
      || !isCounter(input.totalFiles)
      || input.indexedFiles + input.skippedFiles > input.totalFiles
      || (input.providerJobId !== undefined && (typeof input.providerJobId !== 'string' || input.providerJobId.trim().length === 0))) {
      return err(appError('INVALID_INPUT', 'Thai-RAG workspace verification input is invalid'));
    }
    const stored: StoredVerification = {
      schemaVersion: 1,
      workspaceId: namespace.value.workspaceId,
      sourceIdentity: input.sourceIdentity,
      verifiedAt: this.now().toISOString(),
      outcome: input.outcome,
      ...(input.providerStatus === undefined ? {} : { providerStatus: input.providerStatus }),
      indexedFiles: input.indexedFiles,
      skippedFiles: input.skippedFiles,
      totalFiles: input.totalFiles,
      ...(input.sourceSnapshotId === undefined ? {} : { sourceSnapshotId: input.sourceSnapshotId }),
      ...(input.generationId === undefined ? {} : { generationId: input.generationId }),
      ...(input.providerJobId === undefined ? {} : { providerJobId: input.providerJobId }),
    };
    let temporaryPath: string | undefined;
    try {
      await mkdir(namespace.value.root, { recursive: true, mode: 0o700 });
      const filePath = verificationPath(namespace.value.root);
      temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
      await writeFile(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, filePath);
      return ok(withWorkspaceId(stored, namespace.value.workspaceId));
    } catch {
      if (temporaryPath !== undefined) await rm(temporaryPath, { force: true }).catch(() => undefined);
      return err(appError('INTERNAL_ERROR', 'Unable to persist Thai-RAG workspace verification', true));
    }
  }

  public async invalidate(workspaceId: string): Promise<Result<void>> {
    const namespace = resolveThaiRagWorkspaceNamespace(this.dataRoot, workspaceId);
    if (!namespace.ok) return namespace;
    try {
      await rm(verificationPath(namespace.value.root), { force: true });
      return ok(undefined);
    } catch {
      return err(appError('INTERNAL_ERROR', 'Unable to invalidate Thai-RAG workspace verification', true));
    }
  }
}

function verificationPath(namespaceRoot: string): string {
  return path.join(namespaceRoot, 'verification.json');
}

function withWorkspaceId(
  stored: StoredVerification,
  workspaceId: CanonicalWorkspaceId,
): ThaiRagWorkspaceVerificationRecord {
  return {
    workspaceId,
    sourceIdentity: stored.sourceIdentity,
    verifiedAt: stored.verifiedAt,
    outcome: stored.outcome,
    ...(stored.providerStatus === undefined ? {} : { providerStatus: stored.providerStatus }),
    indexedFiles: stored.indexedFiles,
    skippedFiles: stored.skippedFiles,
    totalFiles: stored.totalFiles,
    ...(stored.sourceSnapshotId === undefined ? {} : { sourceSnapshotId: stored.sourceSnapshotId }),
    ...(stored.generationId === undefined ? {} : { generationId: stored.generationId }),
    ...(stored.providerJobId === undefined ? {} : { providerJobId: stored.providerJobId }),
  };
}

function parseStoredVerification(value: unknown, workspaceId: CanonicalWorkspaceId): StoredVerification | null {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.workspaceId !== 'string'
    || value.workspaceId !== workspaceId
    || !isSourceIdentity(value.sourceIdentity)
    || !isOutcome(value.outcome)
    || typeof value.verifiedAt !== 'string'
    || !isCounter(value.indexedFiles)
    || !isCounter(value.skippedFiles)
    || !isCounter(value.totalFiles)
    || value.indexedFiles + value.skippedFiles > value.totalFiles
    || (value.providerStatus !== undefined && typeof value.providerStatus !== 'string')
    || (value.sourceSnapshotId !== undefined && typeof value.sourceSnapshotId !== 'string')
    || (value.generationId !== undefined && typeof value.generationId !== 'string')
    || (value.providerJobId !== undefined && (typeof value.providerJobId !== 'string' || value.providerJobId.trim().length === 0))) return null;
  return {
    schemaVersion: 1,
    workspaceId: value.workspaceId,
    sourceIdentity: value.sourceIdentity,
    verifiedAt: value.verifiedAt,
    outcome: value.outcome,
    ...(value.providerStatus === undefined ? {} : { providerStatus: value.providerStatus }),
    indexedFiles: value.indexedFiles,
    skippedFiles: value.skippedFiles,
    totalFiles: value.totalFiles,
    ...(value.sourceSnapshotId === undefined ? {} : { sourceSnapshotId: value.sourceSnapshotId }),
    ...(value.generationId === undefined ? {} : { generationId: value.generationId }),
    ...(value.providerJobId === undefined ? {} : { providerJobId: value.providerJobId }),
  };
}

function isSourceIdentity(value: unknown): value is WorkspaceSourceEvidenceIdentity {
  if (!isRecord(value)) return false;
  return ['repositoryIdentity', 'gitCommonDirIdentity', 'worktreeIdentity', 'workspaceHead', 'dirtyFingerprint', 'stagedFingerprint']
    .every((key) => typeof value[key] === 'string' && value[key].length > 0)
    && (value.branchName === undefined || typeof value.branchName === 'string');
}

function isOutcome(value: unknown): value is ThaiRagVerificationOutcome {
  return value === 'unchanged' || value === 'changed' || value === 'degraded';
}

function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}
