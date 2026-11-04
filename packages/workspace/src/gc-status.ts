import type { ArtifactQuarantineStore, QuarantineTarget } from './artifact-quarantine.js';
import { quarantineDeadline, quarantineEntryTarget } from './artifact-quarantine.js';
import type { GcLeaseStore } from './gc-lease.js';

export interface GcStatusDeps {
  readonly quarantine: ArtifactQuarantineStore;
  readonly lease: GcLeaseStore;
}

export interface GcStatusInput {
  readonly now: Date;
}

/** One quarantine row, with the deadline that decides when expiry may touch it. */
export interface GcQuarantineRow {
  readonly target: QuarantineTarget;
  readonly quarantinedAt: string;
  readonly graceMs: number;
  /** Deadline as an ISO timestamp, or null when the row's own times are unreadable. */
  readonly expiresAt: string | null;
  /** True once the deadline has passed; reachability is deliberately not judged here. */
  readonly due: boolean;
}

export interface GcQuarantineSummary {
  readonly total: number;
  readonly due: number;
  readonly inGrace: number;
  readonly rows: readonly GcQuarantineRow[];
}

/**
 * The lease as an operator reads it: a held lease carries whether its own
 * deadline has already passed, because the next `--apply` can refuse on a
 * record that is nominally free again until `acquire` overwrites it.
 */
export type GcLeaseReport =
  | { readonly status: 'free' }
  | {
    readonly status: 'held';
    readonly ownerId: string;
    readonly generation: number;
    readonly acquiredAt: string;
    readonly expiresAt: string;
    readonly expired: boolean;
  }
  | {
    readonly status: 'released';
    readonly ownerId: string;
    readonly generation: number;
    readonly expiresAt: string;
    readonly releasedAt: string;
  }
  | { readonly status: 'corrupt' };

export interface GcStatusReport {
  /** `degraded` when the lease record is unreadable: the next destructive pass refuses. */
  readonly status: 'healthy' | 'degraded';
  readonly lease: GcLeaseReport;
  readonly quarantine: GcQuarantineSummary;
}

/**
 * Read-only GC status projection for operators (#210 §7).
 *
 * One snapshot answering the two questions that decide whether running a
 * destructive verb is safe right now: who holds the GC lease, and which
 * quarantine rows have passed their grace deadline. It never takes the lease,
 * never releases a row and never evaluates reachability — a due row is
 * reported as due, never as garbage; that verdict belongs to
 * `index gc expire --dry-run`, which re-assembles the reachability roots.
 *
 * A due row is a normal state and does not degrade the report. Only an
 * unreadable lease does, because the following `--apply` will refuse.
 */
export async function gcStatus(deps: GcStatusDeps, input: GcStatusInput): Promise<GcStatusReport> {
  const [inspection, entries] = await Promise.all([deps.lease.inspect(), deps.quarantine.list()]);
  const now = input.now.getTime();
  const rows = entries
    .map((entry): GcQuarantineRow => {
      // One predicate also decides the destructive pass, so a deadline this
      // projection calls unreadable can never be deleted by an expire run.
      const deadline = quarantineDeadline(entry);
      const expiresAt = deadline === null ? null : new Date(deadline).toISOString();
      // The expire pass uses the same test: `now >= deadline`. A row whose own
      // deadline cannot be read is never due, so it cannot be deleted by
      // accident.
      const due = deadline !== null && now >= deadline;
      return { target: quarantineEntryTarget(entry), quarantinedAt: entry.quarantinedAt, graceMs: entry.graceMs, expiresAt, due };
    })
    .sort((a, b) => (a.due === b.due ? compareTargets(a.target, b.target) : a.due ? -1 : 1));

  const lease: GcLeaseReport = inspection.status !== 'held'
    ? inspection
    : {
      status: 'held',
      ownerId: inspection.ownerId,
      generation: inspection.generation,
      acquiredAt: inspection.acquiredAt,
      expiresAt: inspection.expiresAt,
      // `acquire` grants when `now >= expiresAt`, so an unreadable deadline is
      // reported as expired: saying "held" would claim a fence that would not hold.
      expired: !(now < Date.parse(inspection.expiresAt)),
    };

  return {
    status: lease.status === 'corrupt' ? 'degraded' : 'healthy',
    lease,
    quarantine: {
      total: rows.length,
      due: rows.filter((row) => row.due).length,
      inGrace: rows.filter((row) => !row.due).length,
      rows,
    },
  };
}

function compareTargets(a: QuarantineTarget, b: QuarantineTarget): number {
  const left = targetKey(a);
  const right = targetKey(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function targetKey(target: QuarantineTarget): string {
  return typeof target === 'string' ? target : `${target.repositoryId}\u0000${target.artifactKey}`;
}
