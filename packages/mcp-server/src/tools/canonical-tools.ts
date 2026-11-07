import { appError, err, ok } from '@unified-mpc/domain';
import {
  defineTool,
  missingService,
  type McpToolContext,
  type McpToolDefinition,
} from './tool-types.js';
import { canonicalIndexStatusSchema } from './schemas.js';

/**
 * Read-only canonical index observability (#210 §7/§11).
 *
 * The CLI owns the canonical stores and every mutating lifecycle verb. This
 * surface only projects the same `canonicalStatus()` report the operator CLI
 * and WebUI use, so an agent can diagnose a stale ref, a drifted Goal overlay,
 * an unsettled job or a GC blocker without shelling out.
 */
export function canonicalTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'canonical_index_status',
      description: 'Read the canonical index store without mutating it. Reports the health verdict; each ref with its commit, tree, manifest identity, entry count and pin reasons; each Goal overlay with base=live|drifted|missing and modified/added/deleted counts; each unsettled index job with manifest presence; manifest/pin/overlay/quarantine/active-job counts; and the dangling-ref, missing-overlay-base and orphaned-pin blockers that would stop GC. Distinct from rag_index_status (provider execution history) and workspace_index_status (workspace file index). The report never includes provider job ids, provider result payloads or raw store paths.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: canonicalIndexStatusSchema,
      handler: async () => {
        const status = context.services.canonicalIndexStatus;
        if (status === undefined) return missingService();
        try {
          const report = await status();
          return ok({ scope: 'canonical-store', ...report });
        } catch {
          // A store error can name a local path; keep the response fixed.
          return err(appError('INTERNAL_ERROR', 'Canonical index store status could not be read', true));
        }
      },
    }),
  ];
}
