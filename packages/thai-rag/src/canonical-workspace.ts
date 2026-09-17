import path from 'node:path';
import { appError, err, ok, type Result } from '@unified-mpc/domain';

/** Branded canonical Unified workspace identity; only registration-issued UUIDs qualify. */
export type CanonicalWorkspaceId = string & { readonly __brand: 'CanonicalWorkspaceId' };

const CANONICAL_WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Stable native provider identity reported to observability (#3). */
export const THAI_RAG_PROVIDER_ID = 'thai-rag';

/** Bumped whenever the on-disk namespace layout changes in a forward-incompatible way. */
export const THAI_RAG_NAMESPACE_LAYOUT_VERSION = 1;

/**
 * Canonical workspace data namespace under the Unified-owned provider data root.
 * Every workspace-scoped data type (durable memories, code index, CPG, vectors,
 * file cache) keys off the canonical workspace UUID, never a basename or path.
 */
export interface ThaiRagWorkspaceNamespace {
  readonly workspaceId: CanonicalWorkspaceId;
  readonly root: string;
  readonly memories: string;
  readonly codeIndex: string;
  readonly cpg: string;
  readonly vectors: string;
  readonly cache: string;
  readonly manifest: string;
}

export function parseCanonicalWorkspaceId(value: string): Result<CanonicalWorkspaceId> {
  if (value !== value.trim() || !CANONICAL_WORKSPACE_ID_PATTERN.test(value)) {
    return err(appError(
      'INVALID_INPUT',
      'Workspace scope must be the canonical Unified workspace UUID issued by workspace registration; free-form names, basenames, and paths cannot address provider data',
    ));
  }
  return ok(value as CanonicalWorkspaceId);
}

export function resolveThaiRagProviderRoot(dataRoot: string): Result<string> {
  const root = dataRoot.trim();
  if (root.length === 0 || !path.isAbsolute(root)) {
    return err(appError(
      'INVALID_INPUT',
      'Thai-RAG provider state must live under an absolute Unified-owned data root, not an implicit cache root',
    ));
  }
  return ok(path.join(root, THAI_RAG_PROVIDER_ID));
}

export function resolveThaiRagWorkspaceNamespace(dataRoot: string, workspaceId: string): Result<ThaiRagWorkspaceNamespace> {
  const parsedId = parseCanonicalWorkspaceId(workspaceId);
  if (!parsedId.ok) return parsedId;
  const providerRoot = resolveThaiRagProviderRoot(dataRoot);
  if (!providerRoot.ok) return providerRoot;
  const workspaceRoot = path.join(providerRoot.value, 'workspaces', parsedId.value);
  return ok({
    workspaceId: parsedId.value,
    root: workspaceRoot,
    memories: path.join(workspaceRoot, 'memories.sqlite'),
    codeIndex: path.join(workspaceRoot, 'code-index'),
    cpg: path.join(workspaceRoot, 'cpg'),
    vectors: path.join(workspaceRoot, 'vectors'),
    cache: path.join(workspaceRoot, 'cache'),
    manifest: path.join(workspaceRoot, 'manifest.json'),
  });
}
