import type { FileActor } from '@unified-mpc/application';
import { isMcpRuntimeDiagnosticsSnapshot, type McpRuntimeDiagnosticsSnapshot } from '@unified-mpc/shared';
import type { ActivityTracker } from './activity-tracker.js';
import type { IncrementalVerifier } from './incremental-verifier.js';
import type { McpApplicationServices } from './tools/tool-types.js';
import { UpgradeRuntimeService } from './upgrade-runtime.js';

export type McpRuntimeDiagnosticsProvider = () => Promise<McpRuntimeDiagnosticsSnapshot>;

export function createMcpRuntimeDiagnosticsProvider(options: {
  readonly services: McpApplicationServices;
  readonly actor: FileActor;
  readonly activityTracker?: ActivityTracker;
  readonly incrementalVerifier?: IncrementalVerifier;
}): McpRuntimeDiagnosticsProvider {
  return async (): Promise<McpRuntimeDiagnosticsSnapshot> => {
    const runtime = new UpgradeRuntimeService(
      options.services,
      options.actor,
      undefined,
      () => true,
      options.incrementalVerifier,
      options.activityTracker,
    );
    const result = await runtime.execute('telemetry_dashboard', {});
    if (!result.ok) throw new Error(`Runtime telemetry unavailable: ${result.error.message}`);
    if (!isMcpRuntimeDiagnosticsSnapshot(result.value)) {
      throw new Error('Runtime telemetry returned an invalid diagnostics snapshot');
    }
    return result.value;
  };
}
