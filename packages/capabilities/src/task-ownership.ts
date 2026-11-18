export const CAPABILITY_TASK_OWNER_METADATA_KEY = 'unified-mpc.taskOwner.v1';

export const CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY = 'unified-mpc.activeWorkspaceRoot.v1';

/**
 * Optional goal correlation carried beside the owner. A durable task started
 * under a rolling goal belongs to that goal's execution generation, and the
 * generation is the fence a later reader needs: a task from generation N is not
 * evidence for what generation N+1 is doing. Both fields stay optional because a
 * task started outside a goal has no goal to correlate with.
 */
export const CAPABILITY_GOAL_CORRELATION_METADATA_KEY = 'unified-mpc.goalCorrelation.v1';

export interface CapabilityGoalCorrelation {
  readonly goalId: string;
  /** The goal lease generation the task was started under. */
  readonly executionGeneration: number;
}

export interface CapabilityTaskOwner {
  readonly clientId: string;
  readonly sessionId: string;
  readonly workspaceId?: string;
  readonly goalId?: string;
  readonly executionGeneration?: number;
}

export function readCapabilityTaskOwner(input: unknown): CapabilityTaskOwner {
  if (!isRecord(input)) return legacyCapabilityTaskOwner();
  const metadata = isRecord(input.metadata) ? input.metadata : undefined;
  const value = metadata?.[CAPABILITY_TASK_OWNER_METADATA_KEY];
  if (!isRecord(value)) return legacyCapabilityTaskOwner();
  const clientId = boundedString(value.clientId);
  const sessionId = boundedString(value.sessionId);
  if (clientId === undefined || sessionId === undefined) return legacyCapabilityTaskOwner();
  const workspaceId = boundedString(value.workspaceId);
  const goal = readCapabilityGoalCorrelation(input);
  return {
    clientId,
    sessionId,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(goal === undefined ? {} : { goalId: goal.goalId, executionGeneration: goal.executionGeneration }),
  };
}

export function readCapabilityGoalCorrelation(input: unknown): CapabilityGoalCorrelation | undefined {
  if (!isRecord(input)) return undefined;
  const metadata = isRecord(input.metadata) ? input.metadata : undefined;
  const value = metadata?.[CAPABILITY_GOAL_CORRELATION_METADATA_KEY];
  if (!isRecord(value)) return undefined;
  const goalId = boundedString(value.goalId);
  const executionGeneration = value.executionGeneration;
  if (goalId === undefined) return undefined;
  if (typeof executionGeneration !== 'number' || !Number.isSafeInteger(executionGeneration) || executionGeneration < 0) return undefined;
  return { goalId, executionGeneration };
}

export function withCapabilityGoalCorrelation(input: unknown, correlation: CapabilityGoalCorrelation | undefined): unknown {
  if (correlation === undefined) return input;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  const request = input as Record<string, unknown>;
  const metadata = isRecord(request.metadata) ? request.metadata : {};
  return { ...request, metadata: { ...metadata, [CAPABILITY_GOAL_CORRELATION_METADATA_KEY]: correlation } };
}

export function readCapabilityActiveWorkspaceRoot(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const metadata = isRecord(input.metadata) ? input.metadata : undefined;
  const value = metadata?.[CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY];
  if (typeof value !== 'string' || value.includes('\0')) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 32_768 ? trimmed : undefined;
}

export function legacyCapabilityTaskOwner(): CapabilityTaskOwner {
  return { clientId: 'legacy', sessionId: 'legacy' };
}

export function capabilityTaskOwnerMatches(stored: CapabilityTaskOwner, requester: CapabilityTaskOwner): boolean {
  if (stored.workspaceId !== undefined || requester.workspaceId !== undefined) {
    return stored.workspaceId !== undefined
      && requester.workspaceId !== undefined
      && stored.workspaceId === requester.workspaceId;
  }
  return stored.clientId === requester.clientId && stored.sessionId === requester.sessionId;
}

function boundedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 256 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
