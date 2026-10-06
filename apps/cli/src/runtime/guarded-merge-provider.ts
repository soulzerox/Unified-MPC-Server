import type { GuardedMergeDispatchPort } from '@unified-mpc/application';
import type { ExtensionsService } from '@unified-mpc/extensions';

const MERGE_TOOL = 'merge_pull_request';

export function createGuardedMergeDispatchPort(
  extensions: Pick<ExtensionsService, 'describeMcpServer' | 'callMcpTool'>,
  providerServer: () => string,
): GuardedMergeDispatchPort {
  return {
    async dispatchMerge(request): Promise<void> {
      const server = requiredProviderServer(providerServer());
      const described = await extensions.describeMcpServer({ server });
      if (!described.ok) throw new Error(described.error.message);
      if (!described.value.tools.some((tool) => tool.name === MERGE_TOOL)) {
        throw new Error(`Guarded merge provider '${server}' does not expose ${MERGE_TOOL}`);
      }

      const result = await extensions.callMcpTool({
        server,
        tool: MERGE_TOOL,
        arguments: {
          repository_full_name: request.subject.repository,
          pr_number: request.subject.pullRequest,
          merge_method: 'merge',
          expected_head_sha: request.subject.headSha,
        },
        descriptorFingerprint: described.value.provenance.descriptorFingerprint,
        catalogFingerprint: described.value.provenance.catalogFingerprint,
      });
      if (!result.ok) throw new Error(result.error.message);
    },
  };
}

function requiredProviderServer(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 256) {
    throw new Error('Guarded merge provider server setting is invalid');
  }
  return trimmed;
}
