import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface GcLeaseState {
  readonly ownerId: string;
  readonly generation: number;
  readonly token: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  /** Set when the owner released: the record is retired, never deleted, so
   * the generation stays monotonic across release and re-acquire. */
  readonly releasedAt?: string;
}

export interface GcLeaseAcquireInput {
  readonly ownerId: string;
  readonly now: Date;
  readonly ttlMs: number;
}

export type GcLeaseAcquireResult =
  | { readonly status: 'granted'; readonly ownerId: string; readonly generation: number; readonly token: string; readonly expiresAt: string }
  | { readonly status: 'denied'; readonly reason: 'held'; readonly holder: string; readonly expiresAt: string }
  | { readonly status: 'denied'; readonly reason: 'corrupt' };

export interface GcLeaseFenceInput {
  readonly ownerId: string;
  readonly generation: number;
}

function requireOwner(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('ownerId must be non-empty');
  }
  return value.trim();
}

function requireTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('ttlMs must be a positive safe integer');
  }
  return value;
}

function isState(value: unknown): value is GcLeaseState {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.releasedAt !== undefined && typeof record.releasedAt !== 'string') return false;
  return typeof record.ownerId === 'string'
    && record.ownerId.length > 0
    && typeof record.generation === 'number'
    && Number.isSafeInteger(record.generation)
    && record.generation >= 1
    && typeof record.token === 'string'
    && typeof record.acquiredAt === 'string'
    && typeof record.expiresAt === 'string';
}

/**
 * Single-owner GC cleanup lease with a generation fence (#210 U28, §12).
 *
 * Physical deletion must never run twice concurrently against the same
 * canonical store: `acquire` grants one owner at a time, `renew` extends
 * for that owner only, and `release` is fenced on both owner *and*
 * generation so a stale run cannot clear a successor's lease. The
 * generation increments on every grant and is monotonic across release,
 * so a caller that captured an older generation always fails closed.
 *
 * An expired lease is intentionally takeable: that is crash recovery for
 * a run that died mid-delete. Release retires the record instead of
 * deleting it, which is what keeps the generation monotonic — a caller
 * holding generation *n* can never fence into the *n+1* successor's run.
 * A corrupt or unreadable fence refuses to grant (fail-closed): with the
 * holder unknown, starting a destructive pass is the unsafe direction.
 *
 * ponytail: single-host file coordination under <root>/gc/, same ceiling
 * as the other canonical stores — move to the fenced data-root owner if
 * multi-host GC is ever required.
 */
export class GcLeaseStore {
  public constructor(private readonly root: string) {}

  /** The current record while it is held (including a timed-out holder). */
  public async read(): Promise<GcLeaseState | null> {
    const state = await this.readRaw();
    return state !== null && state.releasedAt === undefined ? state : null;
  }

  private async readRaw(): Promise<GcLeaseState | null> {
    let raw: string;
    try {
      raw = await readFile(this.leasePath(), 'utf8');
    } catch (error) {
      // Missing file is a genuinely free lease; any other read failure is not.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return isState(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private async readFenced(): Promise<{ readonly state: GcLeaseState | null; readonly corrupt: boolean }> {
    const state = await this.readRaw();
    if (state !== null) return { state, corrupt: false };
    try {
      await readFile(this.leasePath(), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: null, corrupt: false };
      throw error;
    }
    return { state: null, corrupt: true };
  }

  public async acquire(input: GcLeaseAcquireInput): Promise<GcLeaseAcquireResult> {
    const ownerId = requireOwner(input.ownerId);
    const ttlMs = requireTtl(input.ttlMs);
    const { state: current, corrupt } = await this.readFenced();
    if (corrupt) return { status: 'denied', reason: 'corrupt' };
    if (current !== null && current.releasedAt === undefined && input.now.getTime() < Date.parse(current.expiresAt)) {
      return { status: 'denied', reason: 'held', holder: current.ownerId, expiresAt: current.expiresAt };
    }
    const generation = (current?.generation ?? 0) + 1;
    const token = randomUUID();
    const expiresAt = new Date(input.now.getTime() + ttlMs).toISOString();
    await this.write({
      ownerId,
      generation,
      token,
      acquiredAt: input.now.toISOString(),
      expiresAt,
    });
    return { status: 'granted', ownerId, generation, token, expiresAt };
  }

  public async renew(input: GcLeaseFenceInput & { readonly now: Date; readonly ttlMs: number }): Promise<boolean> {
    const ownerId = requireOwner(input.ownerId);
    const ttlMs = requireTtl(input.ttlMs);
    const current = await this.read();
    if (current === null || current.ownerId !== ownerId || current.generation !== input.generation) return false;
    await this.write({ ...current, expiresAt: new Date(input.now.getTime() + ttlMs).toISOString() });
    return true;
  }

  public async release(input: GcLeaseFenceInput): Promise<boolean> {
    const ownerId = requireOwner(input.ownerId);
    const current = await this.read();
    if (current === null || current.ownerId !== ownerId || current.generation !== input.generation) return false;
    await this.write({ ...current, releasedAt: new Date().toISOString() });
    return true;
  }

  private leasePath(): string {
    return path.join(this.root, 'gc', 'lease.json');
  }

  private async write(state: GcLeaseState): Promise<void> {
    const finalPath = this.leasePath();
    await mkdir(path.dirname(finalPath), { recursive: true });
    const tmpPath = `${finalPath}.tmp-${randomUUID()}`;
    await writeFile(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(tmpPath, finalPath);
  }
}
