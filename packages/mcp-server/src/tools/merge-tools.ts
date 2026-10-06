import { appError, err, ok } from '@unified-mpc/domain';
import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { guardedPrMergeSchema, mergePolicyGetSchema } from './schemas.js';

export function mergeTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'merge_policy_get',
      description: 'Inspect the host-owned repository merge policy used by guarded_pr_merge. The caller cannot override this policy through the merge request.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: mergePolicyGetSchema,
      handler: async (input) => {
        if (context.services.mergePolicy === undefined) return missingService();
        try {
          const policy = await context.services.mergePolicy.getByRepository(input.repository);
          return ok(policy === undefined
            ? { configured: false }
            : { configured: true, policy });
        } catch {
          return err(appError('PERMISSION_DENIED', 'Authoritative merge policy could not be inspected'));
        }
      },
    }),
    defineTool({
      name: 'guarded_pr_merge',
      description: 'Merge one pull request only through the host-owned repository policy and a durable exact-head verification receipt. Caller-supplied policy overrides are not accepted. The provider merge is bound to the requested exact head and is never dispatched when evidence is missing, stale, rejected, or unavailable.',
      permission: 'DANGEROUS',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: guardedPrMergeSchema,
      handler: async (input) => {
        if (context.services.mergePolicy === undefined || context.services.guardedMerge === undefined) {
          return missingService();
        }

        let policy;
        try {
          policy = await context.services.mergePolicy.getByRepository(input.repository);
        } catch {
          return err(appError('PERMISSION_DENIED', 'Authoritative merge policy could not be inspected'));
        }
        if (policy === undefined) {
          return err(appError(
            'PERMISSION_DENIED',
            `No authoritative merge policy is configured for ${input.repository}`,
          ));
        }

        const result = await context.services.guardedMerge.dispatch({
          policy,
          subject: {
            repository: input.repository,
            pullRequest: input.pullRequest,
            headSha: input.headSha,
            baseBranch: input.baseBranch,
            ...(input.baseSha === undefined ? {} : { baseSha: input.baseSha }),
          },
          receiptRef: input.receiptRef,
        });
        if (result.status === 'blocked') {
          return err(appError('PERMISSION_DENIED', 'Guarded merge was blocked by verification or review policy'));
        }
        if (result.status === 'inspect_required') {
          return err(appError('CONFLICT', `Guarded merge requires inspection: ${result.reason}`, true));
        }
        return ok(result);
      },
    }),
  ];
}
