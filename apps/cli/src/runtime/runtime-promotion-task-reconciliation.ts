import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  DurableShellTaskExternalReconciliationDescriptor,
  DurableShellTaskExternalReconciliationResult,
  DurableShellTaskReconciliationProvider,
} from '@unified-mpc/capabilities';

const RECONCILIATION_KIND = 'unified_runtime_promotion_v1';
const DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface RuntimePromotionTaskReconciliationOptions {
  readonly stateRoot?: string;
  readonly installedPromoterPath?: string;
}

interface PromotionReconciliationKey {
  readonly deploymentId: string;
  readonly candidatePath: string;
}

export function createRuntimePromotionTaskReconciliation(
  options: RuntimePromotionTaskReconciliationOptions = {},
): DurableShellTaskReconciliationProvider {
  const home = process.env.HOME ?? os.homedir();
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  const stateHome = process.env.XDG_STATE_HOME ?? path.join(home, '.local', 'state');
  const configDir = process.env.UNIFIED_MPC_CONFIG_DIR ?? path.join(configHome, 'unified-mpc');
  const installedPromoterPath = canonicalPath(
    options.installedPromoterPath ?? path.join(configDir, 'promote-runtime.sh'),
  );
  const stateRoot = path.resolve(
    options.stateRoot ?? process.env.UNIFIED_MPC_DEPLOY_STATE_DIR ?? path.join(stateHome, 'unified-mpc', 'deployments'),
  );

  return {
    describe(input): DurableShellTaskExternalReconciliationDescriptor | undefined {
      const parsed = parsePromotionInvocation(input.executable, input.arguments, installedPromoterPath);
      if (parsed === undefined) return undefined;
      return {
        kind: RECONCILIATION_KIND,
        key: JSON.stringify({
          deploymentId: parsed.deploymentId,
          candidatePath: canonicalPath(parsed.candidatePath),
        } satisfies PromotionReconciliationKey),
      };
    },
    reconcile: async (
      descriptor: DurableShellTaskExternalReconciliationDescriptor,
    ): Promise<DurableShellTaskExternalReconciliationResult | undefined> => {
      if (descriptor.kind !== RECONCILIATION_KIND) return undefined;
      const key = parseReconciliationKey(descriptor.key);
      if (key === undefined) {
        return { state: 'failed', exitCode: -1, error: 'Runtime promotion reconciliation descriptor is invalid' };
      }
      const recordRoot = path.join(stateRoot, key.deploymentId);
      const status = await readTrimmed(path.join(recordRoot, 'status'));
      if (status === undefined) return undefined;

      const candidatePath = await readTrimmed(path.join(recordRoot, 'candidate_path'));
      if (candidatePath === undefined) {
        return {
          state: 'failed',
          exitCode: -1,
          error: 'Runtime promotion deployment receipt is missing candidate identity',
        };
      }
      if (canonicalPath(candidatePath) !== canonicalPath(key.candidatePath)) {
        return {
          state: 'failed',
          exitCode: -1,
          error: 'Runtime promotion deployment receipt candidate does not match the submitted task',
        };
      }

      if (status === 'pending' || status === 'activated' || status === 'rollback_pending') {
        return { state: 'running' };
      }
      if (status === 'healthy') {
        const health = await readTrimmed(path.join(recordRoot, 'health_result'));
        const rollback = await readTrimmed(path.join(recordRoot, 'rollback_result'));
        if (health !== 'healthy' || rollback !== 'not_needed') {
          return {
            state: 'failed',
            exitCode: -1,
            error: 'Runtime promotion healthy receipt is internally inconsistent',
          };
        }
        return { state: 'completed', exitCode: 0 };
      }
      if (status === 'rolled_back') {
        return {
          state: 'failed',
          exitCode: 70,
          error: 'Runtime promotion failed; rollback to last-known-good succeeded',
        };
      }
      if (status === 'rollback_failed') {
        return {
          state: 'failed',
          exitCode: 71,
          error: 'Runtime promotion and rollback health verification failed',
        };
      }
      if (status === 'failed_no_rollback') {
        return {
          state: 'failed',
          exitCode: 72,
          error: 'Runtime promotion failed and no last-known-good runtime was available',
        };
      }
      if (status === 'failed') {
        return {
          state: 'failed',
          exitCode: 70,
          error: 'Runtime promotion failed before activation completed',
        };
      }
      return {
        state: 'failed',
        exitCode: -1,
        error: `Runtime promotion deployment receipt has unsupported status '${status}'`,
      };
    },
  };
}

function parsePromotionInvocation(
  executable: string,
  args: readonly string[],
  installedPromoterPath: string,
): { readonly candidatePath: string; readonly deploymentId: string } | undefined {
  const resolvedExecutable = canonicalPath(executable);
  const executableBase = path.basename(resolvedExecutable).toLowerCase();
  let candidatePath: string | undefined;
  let deploymentId: string | undefined;

  if (resolvedExecutable === installedPromoterPath) {
    [candidatePath, deploymentId] = args;
  } else if ((executableBase === 'bash' || executableBase === 'sh') && args.length >= 3) {
    const script = canonicalPath(args[0] ?? '');
    if (script !== installedPromoterPath) return undefined;
    candidatePath = args[1];
    deploymentId = args[2];
  } else {
    return undefined;
  }

  if (candidatePath === undefined || candidatePath.trim().length === 0) return undefined;
  if (deploymentId === undefined || !DEPLOYMENT_ID_PATTERN.test(deploymentId)) return undefined;
  return { candidatePath, deploymentId };
}

function parseReconciliationKey(value: string): PromotionReconciliationKey | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.deploymentId !== 'string' || !DEPLOYMENT_ID_PATTERN.test(record.deploymentId)) return undefined;
    if (typeof record.candidatePath !== 'string' || record.candidatePath.trim().length === 0) return undefined;
    return {
      deploymentId: record.deploymentId,
      candidatePath: record.candidatePath,
    };
  } catch {
    return undefined;
  }
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

async function readTrimmed(filename: string): Promise<string | undefined> {
  try {
    const value = (await readFile(filename, 'utf8')).trim();
    return value.length === 0 ? undefined : value;
  } catch {
    return undefined;
  }
}
