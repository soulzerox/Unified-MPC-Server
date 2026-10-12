import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { GitCommandResult, GitStatusResult } from '@unified-mpc/git';

export interface GoalWorkspaceRetentionGitPort {
  status(cwd: string): Promise<Result<GitStatusResult>>;
  run(cwd: string, args: readonly string[]): Promise<Result<GitCommandResult>>;
}

/**
 * A first-party caller must resolve the Goal ownership / approval and provide
 * these paths from its registered workspace, not arbitrary client input.
 */
export interface SealMixedDirtyGoalWorkspaceRequest {
  readonly goalId: string;
  readonly workspaceId: string;
  readonly sourceRoot: string;
  readonly retentionRoot: string;
  readonly expectedHead: string;
  readonly expectedBranch: string;
  readonly git: GoalWorkspaceRetentionGitPort;
  readonly maxBytes?: number;
}

export interface GoalWorkspaceRetainedFile {
  readonly path: string;
  readonly kind: 'tracked' | 'untracked';
  readonly sha256: string;
  readonly bytes: number;
  readonly mode: number;
}

export interface GoalWorkspaceRetentionManifest {
  readonly manifestSha256: string;
  readonly goalId: string;
  readonly workspaceId: string;
  readonly head: string;
  readonly branch: string;
  readonly retentionPath: string;
  readonly entries: readonly GoalWorkspaceRetainedFile[];
}

const DEFAULT_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 64;
const BLOCK = 64 * 1024;

/** Only Git's observed mixed *unstaged* changes can be retained here. */
function observedMixedEntries(entries: GitStatusResult['entries']): Array<{ path: string; kind: 'tracked' | 'untracked' }> | null {
  if (entries.length < 2 || entries.length > MAX_FILES) return null;
  const seen = new Set<string>();
  const result: Array<{ path: string; kind: 'tracked' | 'untracked' }> = [];
  for (const entry of entries) {
    const name = entry.path;
    if (typeof name !== 'string' || name.length === 0 || name.length > 4096
      || name.startsWith('/') || name.includes('\\') || name.includes(String.fromCharCode(0))
      || name.includes('//') || path.posix.normalize(name) !== name
      || /^[A-Za-z]:/.test(name) || name.split('/').some((part) => part === '.' || part === '..')
      || seen.has(name)) return null;
    seen.add(name);
    if (entry.kind === 'modified' && entry.indexStatus === ' ' && entry.worktreeStatus === 'M') {
      result.push({ path: name, kind: 'tracked' });
    } else if (entry.kind === 'untracked' && entry.indexStatus === '?' && entry.worktreeStatus === '?') {
      result.push({ path: name, kind: 'untracked' });
    } else return null;
  }
  if (!result.some((entry) => entry.kind === 'tracked') || !result.some((entry) => entry.kind === 'untracked')) return null;
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

async function exactGitIdentity(request: SealMixedDirtyGoalWorkspaceRequest): Promise<boolean> {
  const head = await request.git.run(request.sourceRoot, ['rev-parse', '--verify', 'HEAD']);
  const branch = await request.git.run(request.sourceRoot, ['branch', '--show-current']);
  return head.ok && branch.ok
    && head.value.exitCode === 0 && head.value.stdout.trim() === request.expectedHead
    && branch.value.exitCode === 0 && branch.value.stdout.trim() === request.expectedBranch;
}

async function hashCurrentSource(fileName: string, sourceRoot: string, maxBytes: number): Promise<{ sha256: string; bytes: number; mode: number }> {
  const full = path.join(sourceRoot, fileName);
  const resolved = await realpath(full);
  if (resolved !== full || !isContained(sourceRoot, resolved)) throw new Error('Source path symlinked or escaped the registered Goal Workspace');
  const info = await lstat(full);
  if (!info.isFile() || info.size > maxBytes) throw new Error('Unbounded or nonregular source file');
  const source = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const initial = await source.stat();
    if (!initial.isFile() || initial.size > maxBytes) throw new Error('Unbounded or nonregular source descriptor');
    const hash = createHash('sha256');
    const bytes = Buffer.alloc(BLOCK);
    let position = 0;
    while (true) {
      const read = await source.read(bytes, 0, bytes.length, position);
      if (read.bytesRead === 0) break;
      position += read.bytesRead;
      if (position > maxBytes || position > initial.size) throw new Error('File changed or exceeded byte budget during read');
      hash.update(bytes.subarray(0, read.bytesRead));
    }
    const after = await source.stat();
    if (position !== initial.size || after.size !== initial.size || after.mtimeMs !== initial.mtimeMs) {
      throw new Error('Source changed during retention verification');
    }
    return { sha256: hash.digest('hex'), bytes: position, mode: initial.mode & 0o777 };
  } finally {
    await source.close();
  }
}

async function copySourceToSealedFile(fileName: string, sourceRoot: string, target: string, maxBytes: number): Promise<{ sha256: string; bytes: number; mode: number }> {
  const before = await hashCurrentSource(fileName, sourceRoot, maxBytes);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const input = await open(path.join(sourceRoot, fileName), constants.O_RDONLY | constants.O_NOFOLLOW);
  const output = await open(target, 'wx', 0o400);
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(BLOCK);
    let position = 0;
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      if (position > maxBytes || position > before.bytes) throw new Error('Copy exceeded proven file size');
      await output.writeFile(buffer.subarray(0, bytesRead));
      hash.update(buffer.subarray(0, bytesRead));
    }
    await output.sync();
    const after = await hashCurrentSource(fileName, sourceRoot, maxBytes);
    if (position !== before.bytes || hash.digest('hex') !== before.sha256
      || after.sha256 !== before.sha256 || after.mode !== before.mode) {
      throw new Error('Source changed during copy; retention seal refused');
    }
    return before;
  } finally {
    await input.close();
    await output.close();
    await chmod(target, 0o400).catch(() => undefined);
  }
}

/**
 * Creates a no-overwrite, checksummed retention bundle independent of the
 * dirty original Goal worktree. The returned manifest is NOT writer admission
 * or proof of immutable storage: a separate owner-authenticated service must
 * verify the persisted bytes, seal custody and CAS transfer before relocation.
 * Incomplete bundles are deliberately retained for diagnosis; without a
 * manifest they are never eligible for relocation.
 */
export async function sealMixedDirtyGoalWorkspace(request: SealMixedDirtyGoalWorkspaceRequest): Promise<Result<GoalWorkspaceRetentionManifest>> {
  try {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request.goalId)
      || request.workspaceId.trim().length === 0
      || !/^[0-9a-f]{40,64}$/.test(request.expectedHead) || request.expectedBranch.trim().length === 0
      || !Number.isSafeInteger(request.maxBytes ?? DEFAULT_BYTES)
      || (request.maxBytes ?? DEFAULT_BYTES) < 1
      || (request.maxBytes ?? DEFAULT_BYTES) > 64 * 1024 * 1024) {
      return err(appError('INVALID_INPUT', 'Retention request identity or bounds are invalid'));
    }
    const sourceRoot = await realpath(request.sourceRoot);
    const proposedRoot = path.resolve(request.retentionRoot);
    if (isContained(sourceRoot, proposedRoot)) {
      return err(appError('CONFLICT', 'Retention must be outside the dirty source workspace', true));
    }
    if (!(await exactGitIdentity(request))) return err(appError('CONFLICT', 'Original Git HEAD or branch has changed', true));
    const initial = await request.git.status(request.sourceRoot);
    if (!initial.ok) return initial;
    const observed = observedMixedEntries(initial.value.entries);
    if (observed === null) return err(appError('CONFLICT', 'Expected a bounded mixed tracked/untracked unstaged delta', true));
    const maxBytes = request.maxBytes ?? DEFAULT_BYTES;
    let total = 0;
    // Verify every byte while all original files are still read-only.
    const initialHashes: Array<GoalWorkspaceRetainedFile> = [];
    for (const entry of observed) {
      const seal = await hashCurrentSource(entry.path, sourceRoot, maxBytes - total);
      total += seal.bytes;
      initialHashes.push({ path: entry.path, kind: entry.kind, ...seal });
    }
    await mkdir(proposedRoot, { recursive: true, mode: 0o700 });
    const retentionRoot = await realpath(proposedRoot);
    if (isContained(sourceRoot, retentionRoot)) return err(appError('CONFLICT', 'Retention root resolved inside dirty source', true));
    const retentionPath = await mkdtemp(path.join(retentionRoot, request.goalId + '-'));
    const entries: GoalWorkspaceRetainedFile[] = [];
    for (const seal of initialHashes) {
      const copied = await copySourceToSealedFile(seal.path, sourceRoot, path.join(retentionPath, 'files', seal.path), maxBytes);
      if (copied.sha256 !== seal.sha256 || copied.bytes !== seal.bytes || copied.mode !== seal.mode) {
        throw new Error('Source changed between preflight and copy');
      }
      entries.push(seal);
    }
    const latest = await request.git.status(request.sourceRoot);
    if (!latest.ok) return latest;
    if (JSON.stringify(observedMixedEntries(latest.value.entries)) !== JSON.stringify(observed)
      || !(await exactGitIdentity(request))) {
      return err(appError('CONFLICT', 'Git status, branch or HEAD drifted during retention', true));
    }
    for (const seal of entries) {
      const current = await hashCurrentSource(seal.path, sourceRoot, maxBytes);
      if (current.sha256 !== seal.sha256 || current.bytes !== seal.bytes || current.mode !== seal.mode) {
        return err(appError('CONFLICT', 'Source content changed after retention', true));
      }
    }
    const manifest: Omit<GoalWorkspaceRetentionManifest, 'manifestSha256'> = {
      goalId: request.goalId, workspaceId: request.workspaceId,
      head: request.expectedHead, branch: request.expectedBranch,
      retentionPath, entries,
    };
    const serialized = JSON.stringify(manifest) + '\n';
    const manifestSha256 = createHash('sha256').update(serialized, 'utf8').digest('hex');
    const output = await open(path.join(retentionPath, 'manifest.json'), 'wx', 0o400);
    try {
      await output.writeFile(serialized, 'utf8');
      await output.sync();
    } finally {
      await output.close();
    }
    await chmod(path.join(retentionPath, 'manifest.json'), 0o400);
    return ok({ ...manifest, manifestSha256 });
  } catch (error: unknown) {
    return err(appError('CONFLICT', 'Retention refused: ' + (error instanceof Error ? error.message : 'verification failed'), true));
  }
}

export interface VerifyRetainedGoalWorkspaceBundleRequest {
  readonly retentionPath: string;
  /** Manifest digest pinned by a trusted service outside retentionPath. */
  readonly expectedManifestSha256: string;
  readonly expectedGoalId: string;
  readonly expectedWorkspaceId: string;
  readonly expectedHead: string;
  readonly expectedBranch: string;
}

/** No client-supplied boolean can stand in for an independent retained-file attestation. */
function validRetainedManifest(data: unknown): data is Omit<GoalWorkspaceRetentionManifest, 'manifestSha256'> {
  if (data === null || typeof data !== 'object') return false;
  const manifest = data as Record<string, unknown>;
  if (typeof manifest.goalId !== 'string' || typeof manifest.workspaceId !== 'string'
    || typeof manifest.head !== 'string' || typeof manifest.branch !== 'string'
    || typeof manifest.retentionPath !== 'string' || !Array.isArray(manifest.entries)
    || manifest.entries.length < 2 || manifest.entries.length > MAX_FILES) return false;
  let total = 0;
  const paths = new Set<string>();
  const kinds = new Set<string>();
  for (const entry of manifest.entries as unknown[]) {
    if (entry === null || typeof entry !== 'object') return false;
    const item = entry as Record<string, unknown>;
    if (typeof item.path !== 'string' || item.path.length === 0 || item.path.length > 4096
      || item.path.startsWith('/') || item.path.includes('\\')
      || item.path.includes(String.fromCharCode(0)) || item.path.includes('//')
      || path.posix.normalize(item.path) !== item.path
      || item.path.split('/').some((part) => part === '.' || part === '..')
      || /^[A-Za-z]:/.test(item.path) || paths.has(item.path)
      || (item.kind !== 'tracked' && item.kind !== 'untracked')
      || typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256)
      || !Number.isSafeInteger(item.bytes) || (item.bytes as number) < 0
      || !Number.isSafeInteger(item.mode) || (item.mode as number) < 0
      || (item.mode as number) > 0o777) return false;
    total += item.bytes as number;
    if (total > 64 * 1024 * 1024) return false;
    paths.add(item.path);
    kinds.add(item.kind);
  }
  return kinds.has('tracked') && kinds.has('untracked');
}

/** Reject injected and symbolic-link files/dirs, not just mismatched expected files. */
async function enumerateRetainedFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  const pending = [''];
  let visited = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const dirents = await readdir(path.join(root, directory), { withFileTypes: true });
    for (const dirent of dirents) {
      visited += 1;
      if (visited > 512 || dirent.isSymbolicLink()) throw new Error('Retention tree is unbounded or contains a symlink');
      const relative = path.posix.join(directory, dirent.name);
      if (dirent.isDirectory()) pending.push(relative);
      else if (dirent.isFile()) files.push(relative);
      else throw new Error('Retention tree contains an unsupported entry');
    }
  }
  return files.sort();
}

/**
 * Rehash the on-disk retention manifest and EVERY retained byte independently
 * of creation. The expected manifest SHA must come from first-party durable
 * ownership evidence, never another read of the same directory. This is
 * read-only verification, NOT an immutable custody receipt or write admission.
 */
export async function verifyRetainedGoalWorkspaceBundle(
  request: VerifyRetainedGoalWorkspaceBundleRequest,
): Promise<Result<GoalWorkspaceRetentionManifest>> {
  try {
    if (!/^[0-9a-f]{64}$/.test(request.expectedManifestSha256)
      || !/^[0-9a-f]{40,64}$/.test(request.expectedHead)
      || !request.expectedGoalId || !request.expectedWorkspaceId || !request.expectedBranch) {
      return err(appError('INVALID_INPUT', 'Retention verifier requires trusted exact identity and manifest SHA-256'));
    }
    const retentionPath = path.resolve(request.retentionPath);
    const rootStat = await lstat(retentionPath);
    if (!rootStat.isDirectory() || await realpath(retentionPath) !== retentionPath) {
      return err(appError('CONFLICT', 'Retention root is not an independent real directory', true));
    }
    const manifestPath = path.join(retentionPath, 'manifest.json');
    const manifestStat = await lstat(manifestPath);
    if (!manifestStat.isFile() || manifestStat.size > 128 * 1024 || (manifestStat.mode & 0o777) !== 0o400
      || await realpath(manifestPath) !== manifestPath) {
      return err(appError('CONFLICT', 'Retention manifest is missing, unbounded, writable or symlinked', true));
    }
    const raw = await readFile(manifestPath);
    const actualManifestSha256 = createHash('sha256').update(raw).digest('hex');
    if (actualManifestSha256 !== request.expectedManifestSha256) {
      return err(appError('CONFLICT', 'Retention manifest differs from the external pinned digest', true));
    }
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (!validRetainedManifest(parsed)
      || parsed.goalId !== request.expectedGoalId || parsed.workspaceId !== request.expectedWorkspaceId
      || parsed.head !== request.expectedHead || parsed.branch !== request.expectedBranch
      || parsed.retentionPath !== retentionPath) {
      return err(appError('CONFLICT', 'Retention manifest failed strict identity or content validation', true));
    }
    const expectedFiles = ['manifest.json', ...parsed.entries.map((entry) => path.posix.join('files', entry.path))].sort();
    const actualFiles = await enumerateRetainedFiles(retentionPath);
    if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
      return err(appError('CONFLICT', 'Retention files differ from pinned manifest paths', true));
    }
    const filesRoot = path.join(retentionPath, 'files');
    for (const entry of parsed.entries) {
      const current = await hashCurrentSource(entry.path, filesRoot, entry.bytes);
      if (current.sha256 !== entry.sha256 || current.bytes !== entry.bytes || current.mode !== 0o400) {
        return err(appError('CONFLICT', 'Retained bytes or file mode differ from pinned manifest', true));
      }
    }
    // Detect mutation of the manifest after opening other retained files.
    const after = await readFile(manifestPath);
    if (createHash('sha256').update(after).digest('hex') !== request.expectedManifestSha256) {
      return err(appError('CONFLICT', 'Manifest changed during independent verification', true));
    }
    return ok({ ...parsed, manifestSha256: actualManifestSha256 });
  } catch (error: unknown) {
    return err(appError('CONFLICT', 'Retention verification refused: ' + (error instanceof Error ? error.message : 'unverified'), true));
  }
}
