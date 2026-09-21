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

    const retention = result.value.runtimeRetention;
    return {
      source: result.value.source,
      processMemory: result.value.processMemory,
      runtimeRetention: {
        // UpgradeRuntime session state is owned by request/session-scoped actors.
        // A diagnostics-only runtime must not report its fresh local state as zero.
        tasks: null,
        checkpoints: null,
        hooks: null,
        sessionEntries: null,
        contextLedgerEntries: null,
        // Shared runtime state is persisted independently of the actor session.
        plugins: options.services.runtimeStatePath === undefined ? null : retention.plugins,
        worktrees: options.services.runtimeStatePath === undefined ? null : retention.worktrees,
        // These owners are explicitly process-scoped and injected by composition.
        activityInflight: options.activityTracker === undefined ? null : retention.activityInflight,
        activityCompletedEntries: options.activityTracker === undefined ? null : retention.activityCompletedEntries,
        activityCompletedEntryLimit: options.activityTracker === undefined ? null : retention.activityCompletedEntryLimit,
        incrementalVerificationEntries: options.incrementalVerifier === undefined ? null : retention.incrementalVerificationEntries,
        toolAvailabilitySubscriptions: options.services.runtimeDiagnostics === undefined ? null : retention.toolAvailabilitySubscriptions,
      },
    };
  };
}
