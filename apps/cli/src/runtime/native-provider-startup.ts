export type NativeProviderStartupState = 'ready' | 'degraded';

/**
 * Start the native Thai-RAG provider without taking the MCP server down (#210 U31).
 *
 * The provider port already reports a per-call error when the provider is
 * not started, so a provider that cannot start is a degraded capability
 * — not a reason to exit. Exiting loses every unrelated tool (files, git,
 * workspace, memory) for the whole session, which is the real failure the
 * client sees as `Connection closed: MCP server process exited with code 1`.
 *
 * The common trigger is a shared provider root whose owner is held by an
 * older release that is still alive but unreachable, so the diagnostic
 * line must carry the provider's own reason verbatim.
 */
export async function startNativeProviderOrDegrade(
  initialize: () => Promise<void>,
  writeDiagnostic: (line: string) => void,
): Promise<NativeProviderStartupState> {
  try {
    await initialize();
    return 'ready';
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    writeDiagnostic(`Unified-MPC Thai-RAG startup state=degraded error=${reason}\n`);
    return 'degraded';
  }
}
