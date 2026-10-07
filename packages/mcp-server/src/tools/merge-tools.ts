import { appError, err, ok } from '@unified-mpc/domain';
import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { guardedPrMergeSchema, mergePolicyGetSchema, mergeReconcileSchema, mergeVerificationRunSchema } from './schemas.js';

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
      name: 'merge_verification_run',
      description: 'Produce and persist a host-owned exact-head merge verification receipt for one open pull request. The repository policy is authoritative: local command argv and GitHub check requirements come from host configuration, never caller-supplied gate outcomes. Local gates require a clean registered workspace whose origin and HEAD exactly match the PR head. Review evidence is bound to the exact head before a receipt is persisted.',
      permission: 'EXECUTE',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: mergeVerificationRunSchema,
      handler: async (input, signal) => {
        if (context.services.mergePolicy === undefined || context.services.mergeVerificationRun === undefined) {
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

        return context.services.mergeVerificationRun.run({
          policy,
          repository: input.repository,
          pullRequest: input.pullRequest,
          ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
          review: {
            outcome: input.review.outcome,
            ...(input.review.reviewId === undefined ? {} : { reviewId: input.review.reviewId }),
            ...(input.review.evidence === undefined ? {} : { evidence: input.review.evidence }),
          },
        }, signal);
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
    defineTool({
      name: 'merge_reconcile',
      description: 'Observe one pull request from the host GitHub provider, reconcile its actual post-merge state against the authoritative repository policy and optional exact-head receipt, and persist immutable reconciliation evidence. A merged PR without a valid receipt is surfaced as a policy breach rather than terminal success.',
      permission: 'WRITE',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: mergeReconcileSchema,
      handler: async (input) => {
        if (context.services.mergePolicy === undefined || context.services.mergeReconciliation === undefined) {
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

        const result = await context.services.mergeReconciliation.reconcile({
          policy,
          repository: input.repository,
          pullRequest: input.pullRequest,
          expectedMergeMethod: input.expectedMergeMethod ?? 'merge',
          ...(input.receiptRef === undefined ? {} : { receiptRef: input.receiptRef }),
        });
        return ok(result);
      },
    }),
  ];
}
