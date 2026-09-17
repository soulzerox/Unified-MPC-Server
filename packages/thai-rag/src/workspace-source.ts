import { lstat, mkdir, readlink, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import { parseCanonicalWorkspaceId, resolveThaiRagProviderRoot } from './canonical-workspace.js';

export async function ensureThaiRagWorkspaceSourceAlias(
  dataRoot: string,
  workspaceId: string,
  workspaceRoot: string,
): Promise<Result<string>> {
  const parsed = parseCanonicalWorkspaceId(workspaceId);
  if (!parsed.ok) return parsed;
  const providerRoot = resolveThaiRagProviderRoot(dataRoot);
  if (!providerRoot.ok) return providerRoot;
  if (!path.isAbsolute(workspaceRoot)) {
    return err(appError('INVALID_INPUT', 'Thai-RAG workspace source root must be absolute'));
  }

  const sourcesRoot = path.join(providerRoot.value, 'sources');
  const alias = path.join(sourcesRoot, parsed.value);
  const target = path.resolve(workspaceRoot);
  await mkdir(sourcesRoot, { recursive: true });

  try {
    const stat = await lstat(alias);
    if (!stat.isSymbolicLink()) {
      return err(appError('CONFLICT', `Thai-RAG source alias path is occupied by a non-symlink: ${alias}`, true));
    }
    const existing = path.resolve(sourcesRoot, await readlink(alias));
    if (existing === target) return ok(alias);
    await unlink(alias);
  } catch (error: unknown) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      return err(appError('INTERNAL_ERROR', `Unable to inspect Thai-RAG source alias: ${errorMessage(error)}`, true));
    }
  }

  try {
    await symlink(target, alias, 'dir');
    return ok(alias);
  } catch (error: unknown) {
    return err(appError('INTERNAL_ERROR', `Unable to create Thai-RAG source alias: ${errorMessage(error)}`, true));
  }
}

export function thaiRagSourcesRoot(dataRoot: string): Result<string> {
  const providerRoot = resolveThaiRagProviderRoot(dataRoot);
  return providerRoot.ok ? ok(path.join(providerRoot.value, 'sources')) : providerRoot;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
