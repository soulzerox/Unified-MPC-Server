import { realpath, stat } from 'node:fs/promises';
import { isHostPathWithin, isPosixMountRoot, resolveHostPath, type Workspace, type WorkspaceRepository } from '@unified-mpc/workspace';

export class StrictWorkspaceRepository implements WorkspaceRepository {
  private readonly allowed = new Set<string>();

  public constructor(
    private readonly inner: WorkspaceRepository,
    allowedCanonicalRoots: readonly string[],
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    for (const root of allowedCanonicalRoots) {
      const normalized = normalize(root, this.platform);
      if (normalized !== null) this.allowed.add(normalized);
    }
  }

  public async list(): Promise<Workspace[]> {
    return (await this.inner.list()).filter((workspace) => this.isAllowed(workspace));
  }

  public async get(id: string): Promise<Workspace | null> {
    const workspace = await this.inner.get(id);
    return workspace !== null && this.isAllowed(workspace) ? workspace : null;
  }

  public async insert(workspace: Workspace): Promise<void> {
    if (!this.isAllowed(workspace)) throw new Error('Strict workspace repository rejected a root outside the explicit allowlist');
    await this.inner.insert(workspace);
  }

  public async insertIfAvailable(workspace: Workspace): Promise<boolean> {
    if (!this.isAllowed(workspace)) throw new Error('Strict workspace repository rejected a root outside the explicit allowlist');
    return this.inner.insertIfAvailable === undefined
      ? (await this.inner.insert(workspace), true)
      : this.inner.insertIfAvailable(workspace);
  }

  public async delete(id: string): Promise<void> {
    const workspace = await this.get(id);
    if (workspace === null) return;
    await this.inner.delete(id);
  }

  public async listAll(): Promise<Workspace[]> {
    const workspaces = this.inner.listAll === undefined ? await this.inner.list() : await this.inner.listAll();
    return workspaces.filter((workspace) => this.isAllowed(workspace));
  }

  public async archive(id: string, archivedAt?: string): Promise<void> {
    const workspace = await this.getAny(id);
    if (workspace === null) throw new Error('Strict workspace repository could not find the workspace to archive');
    if (this.inner.archive === undefined) throw new Error('Strict workspace repository cannot archive registrations');
    if (!this.isAllowed(workspace)) throw new Error('Strict workspace repository rejected an archive outside the explicit allowlist');
    await this.inner.archive(id, archivedAt);
  }

  public async archiveMany(ids: readonly string[], archivedAt?: string): Promise<void> {
    const workspaces = await Promise.all(ids.map((id) => this.getAny(id)));
    if (workspaces.some((workspace) => workspace === null)) throw new Error('Strict workspace repository could not find a workspace to archive');
    if (this.inner.archiveMany === undefined) {
      for (const id of ids) await this.archive(id, archivedAt);
      return;
    }
    for (const workspace of workspaces) {
      if (workspace === null || !this.isAllowed(workspace)) throw new Error('Strict workspace repository rejected an archive outside the explicit allowlist');
    }
    await this.inner.archiveMany(ids, archivedAt);
  }

  public async restore(id: string, workspace?: Workspace): Promise<void> {
    const existing = await this.getAny(id);
    const candidate = workspace ?? existing;
    if (candidate === null || candidate === undefined) throw new Error('Strict workspace repository could not find the workspace to restore');
    if (!this.isAllowed(candidate)) throw new Error('Strict workspace repository rejected a restore outside the explicit allowlist');
    if (this.inner.restore === undefined) throw new Error('Strict workspace repository cannot restore registrations');
    await this.inner.restore(id, workspace);
  }

  public async getAny(id: string): Promise<Workspace | null> {
    const workspace = this.inner.getAny === undefined ? await this.inner.get(id) : await this.inner.getAny(id);
    return workspace !== null && this.isAllowed(workspace) ? workspace : null;
  }

  private isAllowed(workspace: Workspace): boolean {
    const realRoot = normalize(workspace.realRootPath, this.platform);
    const root = normalize(workspace.rootPath, this.platform);
    return (realRoot !== null && this.allowed.has(realRoot)) || (root !== null && this.allowed.has(root));
  }
}

export async function canonicalizeAllowedRoots(roots: readonly string[], platform: NodeJS.Platform = process.platform): Promise<readonly string[]> {
  if (roots.length === 0) throw new Error('Strict root mode requires at least one explicit --allowed-root or UNIFIED_MPC_ALLOWED_ROOTS entry');
  const canonical: string[] = [];
  const seen = new Set<string>();
  for (const input of roots) {
    const resolved = resolveHostPath(input, platform);
    if (resolved === null) throw new Error(`Strict allowed root uses a foreign host path syntax: ${input}`);
    if (isPosixMountRoot(resolved, platform)) throw new Error(`Strict allowed root must be a project directory, not a POSIX mount root: ${input}`);
    let actual: string;
    try {
      if (!(await stat(resolved)).isDirectory()) throw new Error('not a directory');
      actual = await realpath(resolved);
    } catch {
      throw new Error(`Strict allowed root was not found or is not a directory: ${input}`);
    }
    const key = normalize(actual, platform);
    if (key === null || seen.has(key)) continue;
    seen.add(key);
    canonical.push(actual);
  }
  if (canonical.length === 0) throw new Error('Strict root mode has no usable allowed roots');
  return canonical;
}

export async function requestedPathInsideAllowedRoot(requestedPath: string, allowedCanonicalRoots: readonly string[], platform: NodeJS.Platform = process.platform): Promise<string> {
  let requestedCanonical: string;
  try {
    const resolved = resolveHostPath(requestedPath, platform);
    if (resolved === null) throw new Error('foreign path');
    requestedCanonical = await realpath(resolved);
  } catch {
    throw new Error(`Workspace path does not exist: ${requestedPath}`);
  }
  const matches = allowedCanonicalRoots.filter((root) => isHostPathWithin(root, requestedCanonical, platform));
  if (matches.length === 0) throw new Error(`Workspace path is outside strict allowed roots: ${requestedPath}`);
  matches.sort((left, right) => right.length - left.length);
  return matches[0]!;
}

function normalize(value: string, platform: NodeJS.Platform): string | null {
  const resolved = resolveHostPath(value, platform);
  if (resolved === null) return null;
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}
