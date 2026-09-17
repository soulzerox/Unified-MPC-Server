import { appError, err, ok, type Result } from '@unified-mpc/domain';
import { THAI_RAG_PROVIDER_ID, type CanonicalWorkspaceId } from './canonical-workspace.js';

/** Bumped whenever the structured health contract changes shape for consumers (#3). */
export const THAI_RAG_PROVIDER_SCHEMA_VERSION = 1;

export type ThaiRagProviderLifecycleState = 'stopped' | 'starting' | 'ready' | 'degraded' | 'stopping';

const ALLOWED_LIFECYCLE_TRANSITIONS: Readonly<
  Record<ThaiRagProviderLifecycleState, readonly ThaiRagProviderLifecycleState[]>
> = {
  stopped: ['starting'],
  starting: ['ready', 'degraded', 'stopped'],
  ready: ['degraded', 'stopping', 'starting'],
  degraded: ['ready', 'stopping', 'starting'],
  stopping: ['stopped'],
};

export interface ThaiRagWorkspaceScopeHealth {
  readonly workspaceId: CanonicalWorkspaceId;
  readonly indexGeneration: number;
  readonly ready: boolean;
  readonly reason?: string;
}

export interface ThaiRagProviderComponents {
  readonly workerReachable: boolean;
  readonly sqliteAvailable: boolean;
  readonly ftsAvailable: boolean;
  readonly vectorStoreAvailable: boolean;
  readonly embedderAvailable: boolean;
  readonly lexicalRetrievalAvailable: boolean;
  readonly semanticRetrievalAvailable: boolean;
  readonly activeJobs: readonly string[];
}

/**
 * Structured provider health contract: startup/readiness/restart/shutdown state,
 * provider and index generation identity, and per-workspace scope readiness.
 * Observability (#3) consumes this contract instead of a static connected flag.
 */
export interface ThaiRagProviderHealth {
  readonly schemaVersion: typeof THAI_RAG_PROVIDER_SCHEMA_VERSION;
  readonly providerId: typeof THAI_RAG_PROVIDER_ID;
  readonly providerVersion: string;
  readonly state: ThaiRagProviderLifecycleState;
  readonly embeddingIndexGeneration: number;
  readonly startedAt?: string;
  readonly readyAt?: string;
  /** Holder of the single-owner provider lease when one is enforced. */
  readonly ownerId?: string;
  readonly degradation?: readonly string[];
  readonly components?: ThaiRagProviderComponents;
  readonly workspaces?: readonly ThaiRagWorkspaceScopeHealth[];
}

export function transitionProviderState(
  from: ThaiRagProviderLifecycleState,
  to: ThaiRagProviderLifecycleState,
): Result<ThaiRagProviderLifecycleState> {
  if (ALLOWED_LIFECYCLE_TRANSITIONS[from].includes(to)) return ok(to);
  return err(appError(
    'CONFLICT',
    `Unsupported Thai-RAG provider lifecycle transition: ${from} -> ${to}`,
    true,
  ));
}

export function createProviderHealth(
  providerVersion: string,
  embeddingIndexGeneration: number,
): ThaiRagProviderHealth {
  return {
    schemaVersion: THAI_RAG_PROVIDER_SCHEMA_VERSION,
    providerId: THAI_RAG_PROVIDER_ID,
    providerVersion,
    state: 'stopped',
    embeddingIndexGeneration,
  };
}

export function isProviderHealthReady(health: ThaiRagProviderHealth): boolean {
  return health.state === 'ready' && (health.degradation ?? []).length === 0;
}

/**
 * Incompatible embedding/index generations must be detected rather than mixed:
 * a workspace index may only be served when its generation matches the
 * provider's active embedding index generation.
 */
export function isEmbeddingIndexGenerationCompatible(
  providerGeneration: number,
  workspaceGeneration: number,
): boolean {
  return Number.isInteger(providerGeneration)
    && providerGeneration >= 1
    && Number.isInteger(workspaceGeneration)
    && workspaceGeneration >= 1
    && providerGeneration === workspaceGeneration;
}
