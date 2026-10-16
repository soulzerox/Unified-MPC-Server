import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  decideCanonicalAdvancement,
  type AdvancementDecision,
  type CanonicalRefState,
} from '@unified-mpc/domain';

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

  public async read(ref: string): Promise<CanonicalRefState | null> {
    try {
      const raw = await readFile(this.refPath(ref), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!isRefState(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  public async promote(
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
