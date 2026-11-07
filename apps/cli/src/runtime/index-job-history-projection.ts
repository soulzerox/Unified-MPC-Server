import type { RagIndexJobHistory, RagIndexJobHistoryRow } from '@unified-mpc/mcp-server';
import type { ThaiRagIndexJobListing } from '@unified-mpc/thai-rag';

/**
 * Bound and normalize terminal failure text before it reaches a tool response:
 * control characters cannot break a line or a display, and 400 characters keep
 * one runaway provider error from dominating the payload.
 */
export function sanitizeIndexJobError(error: string): string | undefined {
  // The tool response renders this inline, so collapse control characters and
  // whitespace and bound the length; the full text stays in the ledger.
  const normalized = [...error]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f || character.trim().length === 0 ? ' ' : character;
    })
    .join('')
    .replace(/ {2,}/g, ' ')
    .trim();
  return normalized.length === 0 ? undefined : normalized.slice(0, 400);
}

/**
 * Project the CLI-owned durable index-job ledger into the MCP tool shape.
 *
 * This is the safety boundary: provider job ids, the raw provider `result`
 * payload, owner identity (owner ids embed the host pid), owner-process
 * identity and `legacyData` are dropped here, and a terminal error is
 * sanitized/bounded. Absent counters stay absent instead of becoming `0`, so
 * the response never claims a measurement the row did not record.
 * `legacy-unavailable` rows are counted by the listing, never listed.
 */
export function projectIndexJobHistory(listing: ThaiRagIndexJobListing): RagIndexJobHistory {
  return {
    totalRowCount: listing.totalRowCount,
    matchingRowCount: listing.matchingRowCount,
    legacyRowCount: listing.legacyRowCount,
    jobs: listing.jobs.flatMap((job): RagIndexJobHistoryRow[] => {
      if (job.status === 'legacy-unavailable') return [];
      const error = job.error === undefined ? undefined : sanitizeIndexJobError(job.error);
      return [{
        jobId: job.jobId,
        workspaceId: job.workspaceId,
        ...(job.indexedFiles === undefined ? {} : { indexedFiles: job.indexedFiles }),
        ...(job.skippedFiles === undefined ? {} : { skippedFiles: job.skippedFiles }),
        ...(job.totalFiles === undefined ? {} : { totalFiles: job.totalFiles }),
        ...(job.cacheHitFiles === undefined ? {} : { cacheHitFiles: job.cacheHitFiles }),
        ...(job.cacheHitChunks === undefined ? {} : { cacheHitChunks: job.cacheHitChunks }),
        ...(job.cacheMissFiles === undefined ? {} : { cacheMissFiles: job.cacheMissFiles }),
        ...(job.cacheMissChunks === undefined ? {} : { cacheMissChunks: job.cacheMissChunks }),
        ...(job.newEmbeddedFiles === undefined ? {} : { newEmbeddedFiles: job.newEmbeddedFiles }),
        ...(job.newEmbeddedChunks === undefined ? {} : { newEmbeddedChunks: job.newEmbeddedChunks }),
        ...(job.cacheMissReasons === undefined ? {} : { cacheMissReasons: job.cacheMissReasons }),
        status: job.status,
        force: job.force,
        ...(job.reindexReason === undefined ? {} : { reindexReason: job.reindexReason }),
        startedAt: job.startedAt,
        ...(job.progressAt === undefined ? {} : { progressAt: job.progressAt }),
        ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
        ...(error === undefined ? {} : { error }),
      }];
    }),
  };
}
