import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface QuarantineEntry {
  readonly hash: string;
  readonly quarantinedAt: string;
  readonly graceMs: number;
}

export interface QuarantineOptions {
  readonly now: Date;
  readonly graceMs: number;
}

export interface ReleaseCheck {
  readonly now: Date;
  readonly isReachable: (hash: string) => Promise<boolean>;
}

const HASH64 = /^[a-f0-9]{64}$/i;

function requireHash(value: string): string {
  if (!HASH64.test(value)) throw new Error(`invalid artifact hash: ${value}`);
  return value.toLowerCase();
}

function requireGraceMs(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('graceMs must be a positive safe integer');
  }
  return value;
}

function isEntry(value: unknown): value is QuarantineEntry {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.hash === 'string'
    && HASH64.test(record.hash)
    && typeof record.quarantinedAt === 'string'
    && typeof record.graceMs === 'number';
}

/**
 * Artifact quarantine ledger (#210 U21).
 *
 * Physical deletion is reachability-based: unreferenced artifact
 * -> GC candidate -> quarantine/grace -> re-check leases/refs ->
 * physical delete. This ledger owns the middle two steps: `quarantine`
 * records candidates with a grace deadline, and `releaseDue` returns
 * only the hashes that are both expired *and still unreachable when
 * re-checked*. Anything that became reachable again stays quarantined
 * for a human/operator to review — never released silently. One JSON
 * file under <root>/quarantine/, tmp+rename durable.
 *
 * Deletion itself stays a separate, explicitly scheduled step; this
 * returns release candidates only.
 */
export class ArtifactQuarantineStore {
  public constructor(private readonly root: string) {}

  public async quarantine(hashes: readonly string[], options: QuarantineOptions): Promise<QuarantineEntry[]> {
    const graceMs = requireGraceMs(options.graceMs);
    const entries = await this.readAll();
    const byHash = new Map(entries.map((entry) => [entry.hash, entry]));
    for (const hash of hashes) {
      const normalized = requireHash(hash);
      if (!byHash.has(normalized)) {
        byHash.set(normalized, {
          hash: normalized,
          quarantinedAt: options.now.toISOString(),
          graceMs,
        });
      }
    }
    const next = [...byHash.values()].sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
    await this.write(next);
    return next;
  }

  public async list(): Promise<QuarantineEntry[]> {
    return this.readAll();
  }

  public async release(hashes: readonly string[]): Promise<void> {
    const drop = new Set(hashes.map((hash) => requireHash(hash)));
    const entries = await this.readAll();
    await this.write(entries.filter((entry) => !drop.has(entry.hash)));
  }

  public async releaseDue(check: ReleaseCheck): Promise<string[]> {
    const entries = await this.readAll();
    const released: string[] = [];
    const retained: QuarantineEntry[] = [];
    for (const entry of entries) {
      const expiresAt = Date.parse(entry.quarantinedAt) + entry.graceMs;
      if (!Number.isFinite(expiresAt) || check.now.getTime() < expiresAt) {
        retained.push(entry);
        continue;
      }
      if (await check.isReachable(entry.hash)) {
        // Became reachable again after quarantine: keep the evidence for
        // operator review instead of releasing silently.
        retained.push(entry);
        continue;
      }
      released.push(entry.hash);
    }
    if (released.length > 0) {
      await this.write(retained);
    }
    return released.sort();
  }

  private quarantinePath(): string {
    return path.join(this.root, 'quarantine', 'candidates.json');
  }

  private async readAll(): Promise<QuarantineEntry[]> {
    try {
      const raw = await readFile(this.quarantinePath(), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isEntry).sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
    } catch {
      return [];
    }
  }

  private async write(entries: readonly QuarantineEntry[]): Promise<void> {
    const finalPath = this.quarantinePath();
    await mkdir(path.dirname(finalPath), { recursive: true });
    const tmpPath = `${finalPath}.tmp-${randomUUID()}`;
    await writeFile(tmpPath, JSON.stringify(entries, null, 2), { mode: 0o600 });
    await rename(tmpPath, finalPath);
  }
}
