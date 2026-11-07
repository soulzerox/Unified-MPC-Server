import { appError, err, ok, type Result } from '@unified-mpc/domain';
import {
  MAX_OPERATOR_INDEX_JOB_LIMIT,
  parseCanonicalWorkspaceId,
  type ThaiRagIndexJob,
  type ThaiRagIndexJobListing,
} from '@unified-mpc/thai-rag';

export interface IndexJobListCommand {
  readonly kind: 'index-job-list';
  /** Print the unprojected listing instead of the operator lines. */
  readonly json: boolean;
  /** Restrict the listing to one canonical workspace UUID. */
  readonly workspaceId?: string;
  /** Maximum terminal rows; the store also bounds this value. */
  readonly limit?: number;
}

export const MAX_INDEX_JOB_LIST_LIMIT = MAX_OPERATOR_INDEX_JOB_LIMIT;

const INDEX_JOB_LIST_USAGE = 'Usage: unified-mpc index job list [--json] [--workspace <id>] [--limit <n>]';

export function parseIndexJobListArgs(args: readonly string[]): Result<IndexJobListCommand> {
  if (args[0] !== 'job' || args[1] !== 'list') {
    return err(appError('INVALID_INPUT', INDEX_JOB_LIST_USAGE));
  }

  let json = false;
  let workspaceId: string | undefined;
  let limit: number | undefined;
  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--json') {
      if (json) return err(appError('INVALID_INPUT', INDEX_JOB_LIST_USAGE));
      json = true;
      continue;
    }
    if (argument === '--workspace') {
      if (workspaceId !== undefined) return err(appError('INVALID_INPUT', INDEX_JOB_LIST_USAGE));
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) return err(appError('INVALID_INPUT', INDEX_JOB_LIST_USAGE));
      const parsed = parseCanonicalWorkspaceId(value);
      if (!parsed.ok) return err(parsed.error);
      workspaceId = parsed.value;
      index += 1;
      continue;
    }
    if (argument === '--limit') {
      if (limit !== undefined) return err(appError('INVALID_INPUT', INDEX_JOB_LIST_USAGE));
      const value = args[index + 1];
      if (value === undefined || !/^\d+$/.test(value)) return err(appError('INVALID_INPUT', INDEX_JOB_LIST_USAGE));
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_INDEX_JOB_LIST_LIMIT) {
        return err(appError('INVALID_INPUT', `--limit must be an integer between 1 and ${MAX_INDEX_JOB_LIST_LIMIT}`));
      }
      limit = parsed;
      index += 1;
      continue;
    }
    return err(appError('INVALID_INPUT', INDEX_JOB_LIST_USAGE));
  }
  return ok({
    kind: 'index-job-list',
    json,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(limit === undefined ? {} : { limit }),
  });
}

function renderCounters(entries: readonly (readonly [string, number | undefined])[]): string[] {
  return entries
    .filter((entry): entry is readonly [string, number] => entry[1] !== undefined)
    .map(([label, value]) => `${label}=${value}`);
}

function renderJobHeadline(job: ThaiRagIndexJob): string {
  const parts = [job.jobId, job.status, `workspace ${job.workspaceId}`];
  if (job.ownerId !== undefined) parts.push(`owner ${job.ownerId}`);
  if (job.providerJobId !== undefined) parts.push(`provider ${job.providerJobId}`);
  parts.push(`reason ${job.reindexReason ?? 'unrecorded'}`, `started ${job.startedAt}`);
  // Progress is a liveness signal for a live job; a terminal row already has
  // its finish time and does not need the last heartbeat.
  if (job.status === 'running' || job.status === 'cancelling') {
    if (job.progressAt !== undefined) parts.push(`progress ${job.progressAt}`);
  }
  if (job.finishedAt !== undefined) parts.push(`finished ${job.finishedAt}`);
  return parts.join(' ');
}

function renderJobDetails(job: ThaiRagIndexJob): string[] {
  const lines: string[] = [];
  // Absent is not zero: a row written before a metric existed never recorded
  // it, so printing `0` would claim a measurement nobody made.
  const files = renderCounters([
    ['indexed', job.indexedFiles],
    ['skipped', job.skippedFiles],
    ['total', job.totalFiles],
  ]);
  if (files.length > 0) lines.push(`files ${files.join(' ')}`);
  const cache = renderCounters([
    ['hit-files', job.cacheHitFiles],
    ['hit-chunks', job.cacheHitChunks],
    ['miss-files', job.cacheMissFiles],
    ['miss-chunks', job.cacheMissChunks],
    ['new-files', job.newEmbeddedFiles],
    ['new-chunks', job.newEmbeddedChunks],
  ]);
  if (cache.length > 0) lines.push(`cache ${cache.join(' ')}`);
  if (job.cacheMissReasons !== undefined && Object.keys(job.cacheMissReasons).length > 0) {
    const reasons = Object.entries(job.cacheMissReasons)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([reason, count]) => `${reason}=${count}`);
    lines.push(`miss-reasons ${reasons.join(' ')}`);
  }
  if (job.error !== undefined && job.error.trim().length > 0) {
    lines.push(`error ${job.error.replace(/\s+/g, ' ').trim()}`);
  }
  return lines;
}

/**
 * Render the durable index-job ledger (#210 §11).
 *
 * This is the provider-side history `index status` deliberately does not
 * project: what each build reused, newly embedded and skipped, and why it
 * failed. It never claims more than the row recorded — an absent counter prints
 * nothing instead of `0`, and unattributable pre-contract rows are counted as
 * `legacy-unavailable` rather than assigned to a workspace. The raw provider
 * `result` payload is not rendered; `--json` carries it.
 *
 * `jobs` is the number of rows the filter matched; `shown` appears only when
 * the bounded listing is shorter than that, so a short history never looks like
 * a truncated one. Active rows are always listed before terminal history and
 * are never dropped by the bound.
 */
export function formatIndexJobList(listing: ThaiRagIndexJobListing): string {
  const lines = [`jobs ${listing.matchingRowCount}`];
  if (listing.jobs.length < listing.matchingRowCount) lines.push(`shown ${listing.jobs.length}`);
  if (listing.legacyRowCount > 0) lines.push(`legacy-unavailable ${listing.legacyRowCount}`);
  for (const job of listing.jobs) {
    lines.push(`  ${renderJobHeadline(job)}`);
    for (const detail of renderJobDetails(job)) lines.push(`    ${detail}`);
  }
  return lines.join('\n');
}

/** A readable ledger is the whole verdict; a failed job is history, not a store failure. */
export function indexJobListExitCode(): number {
  return 0;
}
