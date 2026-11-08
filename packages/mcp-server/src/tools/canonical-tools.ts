import { appError, err, ok } from '@unified-mpc/domain';
import { boundCanonicalStatusReport } from '@unified-mpc/workspace';
import {
  defineTool,
  missingService,
  type McpToolContext,
  type McpToolDefinition,
} from './tool-types.js';
import { canonicalGcStatusSchema, canonicalIndexStatusSchema, canonicalRevisionListSchema } from './schemas.js';

const DEFAULT_REVISION_LIST_LIMIT = 50;
const DEFAULT_GC_ROW_LIMIT = 50;
const DEFAULT_STATUS_ROW_LIMIT = 50;

/**
 * Read-only canonical index observability (#210 §7/§11).
 *
 * The CLI owns the canonical stores and every mutating lifecycle verb. These
 * surfaces only project the same `canonicalStatus()`, `canonicalRevisionList()`
 * and `gcStatus()` reports the operator CLI and WebUI use, so an agent can
 * diagnose a stale ref, a drifted Goal overlay, an unsettled job, a held GC
 * lease or a quarantined artifact without shelling out.
 */
export function canonicalTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'canonical_index_status',
      description: 'Read the canonical index store without mutating it. Reports the health verdict; each ref with its commit, tree, manifest identity, entry count and pin reasons; each Goal overlay with base=live|drifted|missing and modified/added/deleted counts; each unsettled index job with manifest presence; manifest/pin/overlay/quarantine/active-job counts; and the dangling-ref, missing-overlay-base and orphaned-pin blockers that would stop GC. Rows are bounded: `limit` defaults to 50 (max 200) and every count stays a full-store count (refCount, overlayCount, activeJobCount, danglingRefCount, missingOverlayBaseCount, orphanedPinCount), so a truncated answer is visible instead of silent. The first `limit` rows of each collection are kept in report order: refs by ref name and unsettled jobs oldest-opened first, so a job backlog larger than `limit` returns the stalled jobs that opened earliest (which can differ from the operation-id order `unified-mpc index status` prints) while activeJobCount reports the full backlog. Distinct from rag_index_status (provider execution history) and workspace_index_status (workspace file index). The report never includes provider job ids, provider result payloads or raw store paths.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: canonicalIndexStatusSchema,
      handler: async (input) => {
        const status = context.services.canonicalIndexStatus;
        if (status === undefined) return missingService();
        try {
          const limit = input.limit ?? DEFAULT_STATUS_ROW_LIMIT;
          // The service is asked to apply the bound, but a port implementation
          // that ignores it must not turn the advertised response into the whole
          // store, so the tool bounds again. Counts stay full-store counts.
          const report = boundCanonicalStatusReport(await status({ limit }), limit);
          return ok({ scope: 'canonical-store', ...report });
        } catch {
          // A store error can name a local path; keep the response fixed.
          return err(appError('INTERNAL_ERROR', 'Canonical index store status could not be read', true));
        }
      },
    }),
    defineTool({
      name: 'canonical_gc_status',
      description: 'Read the canonical GC fence and quarantine without mutating them. Reports the health verdict (healthy|degraded), the GC lease as free|held|released|corrupt with owner, generation and expiry, and each quarantine row with its target, grace deadline and due flag. Rows are bounded: `limit` defaults to 50 (max 200) and `returned` reports how many rows this response carries while total/due/inGrace stay full-store counts, so a truncated answer is visible instead of silent. A due row is reported as due, never as garbage; the reachability verdict belongs to `index gc expire --dry-run`. Distinct from canonical_index_status, which reports store-wide blockers. Never takes the lease, releases a row or deletes an artifact.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: canonicalGcStatusSchema,
      handler: async (input) => {
        const status = context.services.canonicalGcStatus;
        if (status === undefined) return missingService();
        try {
          const report = await status();
          const limit = input.limit ?? DEFAULT_GC_ROW_LIMIT;
          const rows = report.quarantine.rows.slice(0, limit);
          return ok({
            scope: 'canonical-store',
            ...report,
            returned: rows.length,
            quarantine: { ...report.quarantine, rows },
          });
        } catch {
          // A store error can name a local path; keep the response fixed.
          return err(appError('INTERNAL_ERROR', 'Canonical GC status could not be read', true));
        }
      },
    }),
    defineTool({
      name: 'canonical_revision_list',
      description: 'Read the canonical revision history without mutating it. Lists stored revision manifests newest first, each with manifest id, repository id, revision id, commit/tree identity, target ref, entry count, created time, and the refs, pin reasons, Goal overlay ids and unsettled index-job ids that still retain it. Bounded: `limit` defaults to 50 (max 200) and `total` reports the full count, so a truncated answer is visible instead of silent. A manifest with no retention markers is unreachable by the prune path. Never prunes or judges reachability.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: canonicalRevisionListSchema,
      handler: async (input) => {
        const list = context.services.canonicalRevisionList;
        if (list === undefined) return missingService();
        try {
          const limit = input.limit ?? DEFAULT_REVISION_LIST_LIMIT;
          const report = await list({ limit });
          // The service is asked to apply the bound, but a port implementation
          // that ignores it must not turn the advertised response into the whole
          // store, so the tool slices again. `total` still reports the store count.
          const revisions = report.revisions.slice(0, limit);
          return ok({
            scope: 'canonical-store',
            total: report.total,
            returned: revisions.length,
            revisions,
          });
        } catch {
          // A store error can name a local path; keep the response fixed.
          return err(appError('INTERNAL_ERROR', 'Canonical revision history could not be read', true));
        }
      },
    }),
  ];
}
