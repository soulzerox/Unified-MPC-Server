import { appError, err, ok, type Result } from '@unified-mpc/domain';

export type ToolsCommand =
  | { readonly kind: 'tools-list' }
  | { readonly kind: 'tools-call'; readonly toolName: string; readonly args: Record<string, unknown> };

export interface ToolSummary {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly permission?: string;
  readonly annotations?: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
  };
}

export function parseToolsArgs(args: readonly string[]): Result<ToolsCommand> {
  if (args.length === 0) {
    return err(appError('INVALID_INPUT', 'Usage: unified-mpc tools list | tools call <name> [jsonArgs]'));
  }

  const subcommand = args[0];
  if (subcommand === 'list') {
    return ok({ kind: 'tools-list' });
  }

  if (subcommand === 'call') {
    if (args.length < 2 || args[1]!.trim().length === 0) {
      return err(appError('INVALID_INPUT', 'Usage: unified-mpc tools call <name> [jsonArgs]'));
    }
    const toolName = args[1]!.trim();
    let toolArgs: Record<string, unknown> = {};
    if (args.length >= 3 && args[2] !== undefined) {
      try {
        const parsed = JSON.parse(args[2]);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return err(appError('INVALID_INPUT', 'Tool arguments must be a valid JSON object'));
        }
        toolArgs = parsed as Record<string, unknown>;
      } catch (parseErr) {
        const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        return err(appError('INVALID_INPUT', `Invalid JSON arguments: ${msg}`));
      }
    }
    return ok({ kind: 'tools-call', toolName, args: toolArgs });
  }

  return err(appError('INVALID_INPUT', `Unknown tools subcommand: ${subcommand}`));
}

export function runToolsList(service: { list(): readonly ToolSummary[] }): readonly ToolSummary[] {
  return service.list();
}

export async function runToolsCall(
  service: { execute(name: string, input: unknown): Promise<unknown> },
  name: string,
  args: Record<string, unknown>,
): Promise<Result<unknown>> {
  try {
    const result = await service.execute(name, args);
    return ok(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(appError('INTERNAL_ERROR', `Failed to execute tool ${name}: ${message}`));
  }
}

