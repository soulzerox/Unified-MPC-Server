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

      const { owner, repo } = repositoryCoordinates(request.subject.repository);
      const result = await extensions.callMcpTool({
        server,
        tool: MERGE_TOOL,
        arguments: {
          owner,
          repo,
          pullNumber: request.subject.pullRequest,
          merge_method: 'merge',
          expectedHeadSha: request.subject.headSha,
        },
        descriptorFingerprint: described.value.provenance.descriptorFingerprint,
        catalogFingerprint: described.value.provenance.catalogFingerprint,
      });
      if (!result.ok) throw new Error(result.error.message);
    },
  };
}

function repositoryCoordinates(value: string): { owner: string; repo: string } {
  const trimmed = value.trim();
  const parts = trimmed.split('/');
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new Error(`Guarded merge repository '${value}' must use owner/repo form`);
  }
  return { owner: parts[0]!, repo: parts[1]! };
}

function requiredProviderServer(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 256) {
    throw new Error('Guarded merge provider server setting is invalid');
  }
  return trimmed;
}
