import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  decideCanonicalAdvancement,
  type AdvancementDecision,
  type CanonicalRefState,
} from '@unified-mpc/domain';
import { errorMessage, isMissingPath, isStrictRead, type ReachabilityReadOptions } from './reachability-read.js';

/** How long a promoter waits for a peer to finish before giving up. */
const LOCK_ATTEMPTS = 400;
const LOCK_RETRY_MS = 25;
/** A lock older than this was left by a crashed promoter and is reclaimed. */
const LOCK_STALE_MS = 30_000;

async function isStaleLock(lockPath: string): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs > LOCK_STALE_MS;
  } catch (error) {
    // Raced with the holder releasing it: the next create attempt decides.
    if (isMissingPath(error)) return true;
    throw error;
  }
}

export interface CanonicalRefPromoteInput {
  /** State the promoter believes is current (CAS expected). */
  readonly expectedCurrent: CanonicalRefState | null;
  /** State actually read from disk at promote time (overridden when omitted). */
  readonly current?: CanonicalRefState | null;
  readonly target: CanonicalRefState;
  readonly targetVerified: boolean;
}

/**
 * Durable CAS persistence for canonical refs (#210 U7).
 *
 * One JSON file per ref under <root>/refs/... written via tmp+rename so a
 * crash never leaves a torn file at the final path. The promote decision is
 * delegated to the pure U6 gate; this class only owns read-after-write
 * durability and the on-disk compare step. Refs are namespaced by full
 * Git ref path — path traversal in a ref name fails closed.
 */
export class CanonicalRefStore {
  public constructor(private readonly root: string) {}

  public async list(options?: ReachabilityReadOptions): Promise<ReadonlyArray<{ readonly ref: string; readonly state: CanonicalRefState }>> {
    const strict = isStrictRead(options);
    const refsDir = path.join(this.root, 'refs');
    let files: Array<{ path: string; ref: string }>;
    try {
      files = await collectJsonFiles(refsDir, 'refs/');
    } catch (error) {
      if (strict && !isMissingPath(error)) {
        throw new Error(`cannot read the canonical refs directory: ${errorMessage(error)}`);
      }
      return [];
    }
    const states: Array<{ ref: string; state: CanonicalRefState }> = [];
    for (const file of files) {
      try {
        const raw = await readFile(file.path, 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (!isRefState(parsed)) throw new Error('not a canonical ref state');
        states.push({ ref: file.ref, state: parsed });
      } catch (error) {
        // Tolerant listings skip unreadable refs; a GC planning read must not,
        // because a skipped ref silently removes its manifest from the roots.
        if (strict) throw new Error(`cannot read canonical ref ${file.ref}: ${errorMessage(error)}`);
      }
    }
    return states.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  }

  public async read(ref: string, options?: ReachabilityReadOptions): Promise<CanonicalRefState | null> {
    let raw: string;
    try {
      raw = await readFile(this.refPath(ref), 'utf8');
    } catch (error) {
      // A missing ref is the ordinary "never promoted" case. Any other read
      // failure is not: a strict caller (the advancement gate) must see it.
      if (isStrictRead(options) && !isMissingPath(error)) {
        throw new Error(`cannot read canonical ref ${ref}: ${errorMessage(error)}`);
      }
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRefState(parsed)) throw new Error('not a canonical ref state');
      return parsed;
    } catch (error) {
      if (isStrictRead(options)) throw new Error(`cannot read canonical ref ${ref}: ${errorMessage(error)}`);
      return null;
    }
  }

  public async promote(
    ref: string,
    input: CanonicalRefPromoteInput,
  ): Promise<AdvancementDecision> {
    // Read, decide and write are one critical section: without the lock two
    // promoters can both read the same state, both decide `promote`, and both
    // rename, so the loser reports a promotion the ref no longer holds.
    const release = await this.acquireRefLock(ref);
    try {
      return await this.promoteLocked(ref, input);
    } finally {
      await release();
    }
  }

  private async promoteLocked(
    ref: string,
    input: CanonicalRefPromoteInput,
  ): Promise<AdvancementDecision> {
    const current = (await this.read(ref)) ?? null;
    const effectiveCurrent = input.current !== undefined ? input.current : current;
    // First-ever promote: no current state exists. The U6 gate works on
    // concrete states, so the store normalizes the unset case here —
    // requiring targetVerified still holds via the delegate below.
    if (effectiveCurrent === null) {
      if (!input.targetVerified) {
        return { action: 'reject_unverified', target: input.target };
      }
      if (input.expectedCurrent !== null) {
        return { action: 'conflict', current };
      }
      const finalPath = this.refPath(ref);
      await mkdir(path.dirname(finalPath), { recursive: true });
      const tmpPath = `${finalPath}.tmp-${randomUUID()}`;
      await writeFile(tmpPath, JSON.stringify(input.target, null, 2), { mode: 0o600 });
      await rename(tmpPath, finalPath);
      return { action: 'promote', target: input.target };
    }
    // A promoter that believed the ref was unset loses to the state already on
    // disk. Falling back to `effectiveCurrent` here would compare the belief
    // against itself and let the second writer overwrite the first.
    if (input.expectedCurrent === null) {
      return { action: 'conflict', current: effectiveCurrent };
    }
    const decision = decideCanonicalAdvancement({
      expectedCurrent: input.expectedCurrent,
      current: effectiveCurrent,
      target: input.target,
      targetVerified: input.targetVerified,
    });
    if (decision.action !== 'promote') return decision;

    const finalPath = this.refPath(ref);
    await mkdir(path.dirname(finalPath), { recursive: true });
    const tmpPath = `${finalPath}.tmp-${randomUUID()}`;
    await writeFile(tmpPath, JSON.stringify(input.target, null, 2), { mode: 0o600 });
    await rename(tmpPath, finalPath);
    return decision;
  }

  /**
   * Cross-process lock for one ref file.
   *
   * `wx` creation is atomic on every filesystem the store targets, and a lock
   * left behind by a crashed promoter is reclaimed once it is older than
   * LOCK_STALE_MS, so a dead process cannot wedge a ref. The lock is a sibling
   * of the ref file and never matches the `.json` listing, so readers ignore it.
   */
  private async acquireRefLock(ref: string): Promise<() => Promise<void>> {
    const lockPath = `${this.refPath(ref)}.lock`;
    await mkdir(path.dirname(lockPath), { recursive: true });
    for (let attempt = 0; ; attempt += 1) {
      try {
        const handle = await open(lockPath, 'wx', 0o600);
        await handle.close();
        return async (): Promise<void> => { await rm(lockPath, { force: true }); };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (await isStaleLock(lockPath)) {
          await rm(lockPath, { force: true });
          continue;
        }
        if (attempt >= LOCK_ATTEMPTS) {
          throw new Error(`canonical ref ${ref} is locked by another promoter`);
        }
        await new Promise((resolve) => { setTimeout(resolve, LOCK_RETRY_MS); });
      }
    }
  }

  private refPath(ref: string): string {
    const parts = ref.split('/').filter((part) => part.length > 0);
    if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) {
      throw new Error(`invalid canonical ref: ${ref}`);
    }
    return path.join(this.root, ...parts) + '.json';
  }
}

function isRefState(value: unknown): value is CanonicalRefState {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.commitSha === 'string'
    && typeof record.treeOid === 'string'
    && typeof record.manifestId === 'string';
}

export { type AdvancementDecision, type CanonicalRefState };

async function collectJsonFiles(dir: string, prefix: string): Promise<Array<{ path: string; ref: string }>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: Array<{ path: string; ref: string }> = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJsonFiles(full, `${prefix}${entry.name}/`)));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push({ path: full, ref: `${prefix}${entry.name.replace(/\.json$/, '')}` });
    }
  }
  return files;
}
