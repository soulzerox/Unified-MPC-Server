import {
  prepareDependencyBootstrap,
  type DependencyBootstrapPlan,
  type ResolveDependencyStrategyInput,
} from './dependency-cache-policy.js';

/** Lifecycle owners that share the managed-worktree dependency contract. */
export type ManagedWorktreeLifecycle = 'goal' | 'delegated';

export interface ManagedWorktreeDependencyBootstrapInput extends ResolveDependencyStrategyInput {
  readonly lifecycle: ManagedWorktreeLifecycle;
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
  const { lifecycle, ...policyInput } = input;
  return { lifecycle, plan: await prepareDependencyBootstrap(policyInput) };
}
