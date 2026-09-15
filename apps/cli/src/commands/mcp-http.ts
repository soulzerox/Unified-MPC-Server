import { appError, err, type Result } from '@unified-mpc/domain';
import { startMcpHttp, type McpHttpServerHandle, type McpHttpServerOptions } from '@unified-mpc/mcp-server';
import type { Workspace } from '@unified-mpc/workspace';

export interface ConfiguredWorkspaceResolver {
  resolve(reference: string): Promise<Result<Workspace>>;
}

export interface McpHttpServerStarter {
  start(options: McpHttpServerOptions): Promise<McpHttpServerHandle>;
}

export interface McpHttpCommandOptions {
  readonly workspaceReference: string;
  readonly resolver: ConfiguredWorkspaceResolver;
  readonly createServerOptions: (workspace: Workspace) => McpHttpServerOptions;
  readonly starter?: McpHttpServerStarter;
}

export interface McpHttpCommandResult {
  readonly workspaceId: string;
  readonly handle: McpHttpServerHandle;
}

const defaultStarter: McpHttpServerStarter = {
  start: startMcpHttp,
};

export type WebMcpHttpServerOptions = Omit<McpHttpServerOptions, 'hostMutationApprovalProvider'>;

export function createWebMcpHttpServerOptions(options: McpHttpServerOptions): WebMcpHttpServerOptions {
  const { hostMutationApprovalProvider, ...webOptions } = options;
  void hostMutationApprovalProvider;
  return webOptions;
}

export async function runMcpHttpCommand(
  options: McpHttpCommandOptions,
): Promise<Result<McpHttpCommandResult>> {
  if (options.workspaceReference.trim().length === 0) {
    return err(appError('INVALID_INPUT', 'A workspace reference is required'));
  }

  const resolved = await options.resolver.resolve(options.workspaceReference);
  if (!resolved.ok) return resolved;

  const serverOptions = createWebMcpHttpServerOptions(options.createServerOptions(resolved.value));
  const handle = await (options.starter ?? defaultStarter).start(serverOptions);
  return {
    ok: true,
    value: { workspaceId: resolved.value.id, handle },
  };
}
