import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import {
  resolveThaiRagWorkspaceNamespace,
  type CanonicalWorkspaceId,
  type ThaiRagWorkspaceNamespace,
} from './canonical-workspace.js';

export type ThaiRagWorkspaceLifecycle =
  | 'active'
  | 'archived-retained'
  | 'temporary-expired'
  | 'orphan-candidate'
  | 'purge-eligible';

export interface ThaiRagIndexGeneration {
  readonly providerSchemaVersion: number;
  readonly embeddingModel: string;
  readonly embeddingDimension: number;
  readonly chunkingVersion: number;
  readonly indexGeneration: number;
  readonly migrationGeneration: number;
}

export interface ThaiRagWorkspaceManifest {
  readonly workspaceId: CanonicalWorkspaceId;
  readonly namespace: ThaiRagWorkspaceNamespace;
  readonly lifecycle: ThaiRagWorkspaceLifecycle;
  readonly generation: ThaiRagIndexGeneration;
  readonly reindexRequired: boolean;
  readonly purgeEligible: boolean;
  readonly temporary: boolean;
  readonly expiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ThaiRagWorkspaceManifestOptions {
  readonly temporary?: boolean;
  readonly expiresAt?: string;
}

interface StoredManifest {
  readonly workspaceId: string;
  readonly lifecycle: ThaiRagWorkspaceLifecycle;
  readonly generation: ThaiRagIndexGeneration;
  readonly reindexRequired: boolean;
  readonly purgeEligible: boolean;
  readonly temporary: boolean;
  readonly expiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class ThaiRagWorkspaceManifestStore {
  private readonly now: () => Date;

  public constructor(
    private readonly dataRoot: string,
    options: { readonly now?: () => Date } = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
  }

  public async ensure(
    workspaceId: string,
    generation: ThaiRagIndexGeneration,
    options: ThaiRagWorkspaceManifestOptions = {},
  ): Promise<Result<ThaiRagWorkspaceManifest>> {
    const existing = await this.get(workspaceId);
    if (!existing.ok) return existing;
    if (existing.value !== null) return ok(existing.value);

    const namespace = resolveThaiRagWorkspaceNamespace(this.dataRoot, workspaceId);
    if (!namespace.ok) return namespace;
    const now = this.now().toISOString();
    const stored: StoredManifest = {
      workspaceId: namespace.value.workspaceId,
      lifecycle: 'active',
      generation,
      reindexRequired: false,
      purgeEligible: false,
      temporary: options.temporary === true,
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
      createdAt: now,
      updatedAt: now,
    };
    return this.persist(namespace.value, stored);
  }

  public async get(workspaceId: string): Promise<Result<ThaiRagWorkspaceManifest | null>> {
    const namespace = resolveThaiRagWorkspaceNamespace(this.dataRoot, workspaceId);
    if (!namespace.ok) return namespace;
    try {
      const parsed: unknown = JSON.parse(await readFile(namespace.value.manifest, 'utf8'));
      const stored = parseStoredManifest(parsed, namespace.value.workspaceId);
      if (stored === null) return err(appError('CONFLICT', 'Thai-RAG workspace manifest is invalid or belongs to another workspace', true));
      return ok(withNamespace(stored, namespace.value));
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') return ok(null);
      return err(appError('INTERNAL_ERROR', 'Unable to read Thai-RAG workspace manifest', true));
    }
  }

  public async archive(workspaceId: string): Promise<Result<ThaiRagWorkspaceManifest>> {
    return this.update(workspaceId, (stored) => ({
      ...stored,
      lifecycle: 'archived-retained',
      purgeEligible: false,
    }));
  }

  public async restore(workspaceId: string, generation: ThaiRagIndexGeneration): Promise<Result<ThaiRagWorkspaceManifest>> {
    return this.update(workspaceId, (stored) => ({
      ...stored,
      lifecycle: 'active',
      generation,
      reindexRequired: !isGenerationCompatible(stored.generation, generation),
      purgeEligible: false,
    }));
  }

  public async reconcile(
    workspaceId: string,
    observation: { readonly filesystemPresent: boolean },
  ): Promise<Result<ThaiRagWorkspaceManifest>> {
    return this.update(workspaceId, (stored) => {
      if (stored.purgeEligible) return stored;
      if (stored.temporary && isExpired(stored.expiresAt, this.now())) {
        return { ...stored, lifecycle: 'temporary-expired', purgeEligible: false };
      }
      if (!observation.filesystemPresent && stored.lifecycle === 'active') {
        return { ...stored, lifecycle: 'orphan-candidate', purgeEligible: false };
      }
      return stored;
    });
  }

  public async authorizePurge(
    workspaceId: string,
    authorization: { readonly explicit: boolean },
  ): Promise<Result<ThaiRagWorkspaceManifest>> {
    if (!authorization.explicit) {
      return err(appError('PERMISSION_DENIED', 'Permanent Thai-RAG purge eligibility requires explicit authorization'));
    }
    return this.update(workspaceId, (stored) => ({
      ...stored,
      lifecycle: 'purge-eligible',
      purgeEligible: true,
    }));
  }

  private async update(
    workspaceId: string,
    transform: (stored: StoredManifest) => StoredManifest,
  ): Promise<Result<ThaiRagWorkspaceManifest>> {
    const existing = await this.get(workspaceId);
    if (!existing.ok) return existing;
    if (existing.value === null) return err(appError('WORKSPACE_NOT_FOUND', 'Thai-RAG workspace manifest was not found', true));
    const stored = toStored(existing.value);
    return this.persist(existing.value.namespace, {
      ...transform(stored),
      updatedAt: this.now().toISOString(),
    });
  }

  private async persist(
    namespace: ThaiRagWorkspaceNamespace,
    stored: StoredManifest,
  ): Promise<Result<ThaiRagWorkspaceManifest>> {
    try {
      await mkdir(namespace.root, { recursive: true });
      const temporaryPath = `${namespace.manifest}.tmp-${process.pid}-${randomUUID()}`;
      await writeFile(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, namespace.manifest);
      return ok(withNamespace(stored, namespace));
    } catch {
      return err(appError('INTERNAL_ERROR', 'Unable to persist Thai-RAG workspace manifest', true));
    }
  }
}

export function isGenerationCompatible(a: ThaiRagIndexGeneration, b: ThaiRagIndexGeneration): boolean {
  return a.providerSchemaVersion === b.providerSchemaVersion
    && a.embeddingModel === b.embeddingModel
    && a.embeddingDimension === b.embeddingDimension
    && a.chunkingVersion === b.chunkingVersion
    && a.indexGeneration === b.indexGeneration
    && a.migrationGeneration === b.migrationGeneration;
}

function withNamespace(stored: StoredManifest, namespace: ThaiRagWorkspaceNamespace): ThaiRagWorkspaceManifest {
  return { ...stored, workspaceId: namespace.workspaceId, namespace };
}

function toStored(manifest: ThaiRagWorkspaceManifest): StoredManifest {
  return {
    workspaceId: manifest.workspaceId,
    lifecycle: manifest.lifecycle,
    generation: manifest.generation,
    reindexRequired: manifest.reindexRequired,
    purgeEligible: manifest.purgeEligible,
    temporary: manifest.temporary,
    ...(manifest.expiresAt === undefined ? {} : { expiresAt: manifest.expiresAt }),
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
  };
}

function parseStoredManifest(value: unknown, workspaceId: CanonicalWorkspaceId): StoredManifest | null {
  if (!isRecord(value)
    || value.workspaceId !== workspaceId
    || !isLifecycle(value.lifecycle)
    || !isGeneration(value.generation)
    || typeof value.reindexRequired !== 'boolean'
    || typeof value.purgeEligible !== 'boolean'
    || typeof value.temporary !== 'boolean'
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string'
    || (value.expiresAt !== undefined && typeof value.expiresAt !== 'string')) return null;
  return {
    workspaceId,
    lifecycle: value.lifecycle,
    generation: value.generation,
    reindexRequired: value.reindexRequired,
    purgeEligible: value.purgeEligible,
    temporary: value.temporary,
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function isGeneration(value: unknown): value is ThaiRagIndexGeneration {
  if (!isRecord(value)) return false;
  return Number.isInteger(value.providerSchemaVersion)
    && typeof value.embeddingModel === 'string'
    && Number.isInteger(value.embeddingDimension)
    && Number.isInteger(value.chunkingVersion)
    && Number.isInteger(value.indexGeneration)
    && Number.isInteger(value.migrationGeneration);
}

function isLifecycle(value: unknown): value is ThaiRagWorkspaceLifecycle {
  return value === 'active'
    || value === 'archived-retained'
    || value === 'temporary-expired'
    || value === 'orphan-candidate'
    || value === 'purge-eligible';
}

function isExpired(expiresAt: string | undefined, now: Date): boolean {
  if (expiresAt === undefined) return false;
  const expires = Date.parse(expiresAt);
  return Number.isFinite(expires) && expires <= now.getTime();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}
