import { link, mkdir, open, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  decideCanonicalAdvancement,
  type AdvancementDecision,
  type CanonicalRefState,
} from '@unified-mpc/domain';
import { errorMessage, isMissingPath, isStrictRead, type ReachabilityReadOptions } from './reachability-read.js';

/** How long a promoter waits for a peer to finish before giving up. */
const LOCK_WAIT_MS = 90_000;
const LOCK_RETRY_MS = 25;
/**
 * A lock whose mtime is older than this was left by a crashed promoter. The
 * holder refreshes that mtime every LOCK_HEARTBEAT_MS, so a promoter that is
 * merely slow is never mistaken for a dead one.
 */
const LOCK_STALE_MS = 60_000;
const LOCK_HEARTBEAT_MS = 15_000;

interface ObservedLock {
  readonly token: string;
  readonly stale: boolean;
}

/** A lock file moved aside by `claimLockFile`, with the owner token it held. */
interface ClaimedLock {
  readonly path: string;
  readonly token: string;
}

interface HeldRefLock {
  readonly path: string;
  readonly token: string;
  release(): Promise<void>;
}

/**
 * Read the lock's owner token and whether its heartbeat is stale.
 *
 * The token is read *before* the mtime on purpose: if the file is replaced in
 * between, the fresh mtime makes a live lock look held, which only delays a
 * reclaim. Reading the mtime first could pair a new token with an old mtime and
 * authorize deleting a lock that was just created.
 */
async function observeLock(lockPath: string): Promise<ObservedLock | null> {
  let token: string;
  try {
    token = (await readFile(lockPath, 'utf8')).trim();
  } catch (error) {
    if (isMissingPath(error)) return null;
    throw error;
  }
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(lockPath)).mtimeMs;
  } catch (error) {
    if (isMissingPath(error)) return null;
    throw error;
  }
  return { token, stale: Date.now() - mtimeMs > LOCK_STALE_MS };
}

async function createLockFile(lockPath: string, token: string): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    await handle.writeFile(`${token}\n`, 'utf8');
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return true;
}

/**
 * Take the lock file out of the way with one atomic rename.
 *
 * POSIX has no compare-and-delete, so removal is claim-then-verify: the caller
 * inspects the token it actually took and restores the file when that token is
 * not the one it meant to remove. `rename` is what makes the take atomic.
 */
async function claimLockFile(lockPath: string): Promise<ClaimedLock | null> {
  const claimPath = `${lockPath}.claim-${randomUUID()}`;
  try {
    await rename(lockPath, claimPath);
  } catch (error) {
    if (isMissingPath(error)) return null;
    throw error;
  }
  let token = '';
  try {
    token = (await readFile(claimPath, 'utf8')).trim();
  } catch {
    // An unreadable claim is foreign by construction and is restored below.
  }
  return { path: claimPath, token };
}

/**
 * Put a displaced lock back without clobbering one created meanwhile.
 *
 * `link` fails when the lock path exists again, which is exactly the guard
 * needed: restoring over a newer lock would steal it a second time. A claim
 * that cannot be restored is dropped; its owner verifies ownership before every
 * ref write, so it fails closed instead of writing beside the new holder.
 */
async function restoreClaimedLock(claim: ClaimedLock, lockPath: string): Promise<boolean> {
  try {
    await link(claim.path, lockPath);
  } catch {
    await rm(claim.path, { force: true }).catch(() => undefined);
    return false;
  }
  await rm(claim.path, { force: true }).catch(() => undefined);
  return true;
}

/**
 * Reclaim a crashed promoter's lock. True means the caller should retry now.
 *
 * A lock is only discarded when the token observed as stale is still the token
 * inside the file that was moved aside; a lock reclaimed and re-taken in the
 * meantime is live and is restored untouched.
 */
async function reclaimStaleLock(lockPath: string): Promise<boolean> {
  const observed = await observeLock(lockPath);
  if (observed === null) return true;
  if (!observed.stale) return false;
  const claimed = await claimLockFile(lockPath);
  if (claimed === null) return true;
  if (claimed.token === observed.token) {
    await rm(claimed.path, { force: true });
    return true;
  }
  return !(await restoreClaimedLock(claimed, lockPath));
}

async function touchLock(lockPath: string, token: string): Promise<void> {
  try {
    const held = (await readFile(lockPath, 'utf8')).trim();
    if (held !== token) return;
    const now = new Date();
    await utimes(lockPath, now, now);
  } catch {
    // Ownership is re-verified before every ref write; the heartbeat only
    // keeps a lock this process still owns from looking abandoned.
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
    const lock = await this.acquireRefLock(ref);
    try {
      return await this.promoteLocked(ref, input, lock);
    } finally {
      // A failed release only leaves a lock that goes stale after
      // LOCK_STALE_MS; it must not mask a decision that already happened.
      await lock.release();
    }
  }

  private async promoteLocked(
    ref: string,
    input: CanonicalRefPromoteInput,
    lock: HeldRefLock,
  ): Promise<AdvancementDecision> {
    // The baseline read is strict: a ref file that exists but cannot be parsed
    // is corruption, not "never promoted". A tolerant read would return null,
    // let the first-ever branch overwrite the evidence, and report a clean
    // advance. `read` still returns null only for a genuinely missing file, so
    // a legitimate first promotion keeps working.
    const current = await this.read(ref, { strict: true });
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
      await this.writeRefState(ref, input.target, lock);
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

    await this.writeRefState(ref, input.target, lock);
    return decision;
  }

  /**
   * Write one ref state via tmp+rename, after proving this process still holds
   * the lock. A promoter whose lock was reclaimed must not rename over the ref.
   */
  private async writeRefState(ref: string, state: CanonicalRefState, lock: HeldRefLock): Promise<void> {
    const finalPath = this.refPath(ref);
    await mkdir(path.dirname(finalPath), { recursive: true });
    const tmpPath = `${finalPath}.tmp-${randomUUID()}`;
    await writeFile(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    let held: string;
    try {
      held = (await readFile(lock.path, 'utf8')).trim();
    } catch {
      await rm(tmpPath, { force: true });
      throw new Error(`canonical ref ${ref} lock was lost before the write`);
    }
    if (held !== lock.token) {
      await rm(tmpPath, { force: true });
      throw new Error(`canonical ref ${ref} lock was lost before the write`);
    }
    await rename(tmpPath, finalPath);
  }

  /**
   * Cross-process lock for one ref file.
   *
   * `wx` creation is atomic on every filesystem the store targets, and the lock
   * carries a unique owner token so a waiter never discards a lock it did not
   * observe. The holder refreshes the lock's mtime while it works, so only a
   * crashed promoter's lock becomes stale (after LOCK_STALE_MS) and is
   * reclaimed. The lock is a sibling of the ref file and never matches the
   * `.json` listing, so readers ignore it.
   */
  private async acquireRefLock(ref: string): Promise<HeldRefLock> {
    const lockPath = `${this.refPath(ref)}.lock`;
    await mkdir(path.dirname(lockPath), { recursive: true });
    const token = randomUUID();
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      if (await createLockFile(lockPath, token)) break;
      if (await reclaimStaleLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`canonical ref ${ref} is locked by another promoter`);
      }
      await new Promise((resolve) => { setTimeout(resolve, LOCK_RETRY_MS); });
    }

    const heartbeat = setInterval(() => { void touchLock(lockPath, token); }, LOCK_HEARTBEAT_MS);
    heartbeat.unref();
    return {
      path: lockPath,
      token,
      release: async (): Promise<void> => {
        clearInterval(heartbeat);
        // The release path never deletes a lock whose token differs: a
        // reclaim may have replaced it while this promoter was finishing.
        await this.releaseLock(lockPath, token).catch(() => undefined);
      },
    };
  }

  private async releaseLock(lockPath: string, token: string): Promise<void> {
    const observed = await observeLock(lockPath);
    if (observed === null || observed.token !== token) return;
    const claimed = await claimLockFile(lockPath);
    if (claimed === null) return;
    if (claimed.token === token) {
      await rm(claimed.path, { force: true });
      return;
    }
    await restoreClaimedLock(claimed, lockPath);
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
