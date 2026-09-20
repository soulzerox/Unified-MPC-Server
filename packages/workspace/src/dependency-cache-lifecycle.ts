import {
  prepareDependencyBootstrap,
  type DependencyBootstrapPlan,
  type ResolveDependencyStrategyInput,
} from './dependency-cache-policy.js';
import {
  ResourceAdmissionController,
  tryAdmitDependencyBootstrap,
  type ResourceAdmissionDecision,
} from './resource-admission.js';

/** Lifecycle owners that share the managed-worktree dependency contract. */
export type ManagedWorktreeLifecycle = 'goal' | 'delegated';

export interface ManagedWorktreeDependencyBootstrapInput extends ResolveDependencyStrategyInput {
  readonly lifecycle: ManagedWorktreeLifecycle;
  readonly admission?: ManagedWorktreeDependencyAdmission;
}

export interface ManagedWorktreeDependencyAdmission {
  readonly controller: ResourceAdmissionController;
  readonly operationId: string;
  readonly workspaceId: string;
  readonly cost: number;
}

export interface ManagedWorktreeDependencyBootstrapResult {
  readonly lifecycle: ManagedWorktreeLifecycle;
  readonly plan: DependencyBootstrapPlan;
}

/**
 * Common boundary for #11 goal worktrees and #6 delegated workspaces.
 * Package-manager detection, isolation, and bootstrap policy remain owned by #34.
 */
export async function prepareManagedWorktreeDependencyBootstrap(
  input: ManagedWorktreeDependencyBootstrapInput,
): Promise<ManagedWorktreeDependencyBootstrapResult> {
  const { lifecycle, admission, ...policyInput } = input;
  const decision: ResourceAdmissionDecision | undefined = admission === undefined
    ? undefined
    : tryAdmitDependencyBootstrap(admission.controller, {
      operationId: admission.operationId,
      workspaceId: admission.workspaceId,
      cost: admission.cost,
    });

  if (decision !== undefined && !decision.admitted) {
    throw Object.assign(new Error(`Managed ${lifecycle} dependency bootstrap rejected by resource admission`), {
      lifecycle,
      ...decision,
    });
  }

  try {
    return { lifecycle, plan: await prepareDependencyBootstrap(policyInput) };
  } finally {
    if (decision?.admitted === true) admission?.controller.release(decision.lease);
  }
}
