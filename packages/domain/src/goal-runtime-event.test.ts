import { describe, expect, it } from 'vitest';
import {
  classifyGoalRuntimeEvent,
  validateGoalStateTransition,
  type ExecutionScopedRuntimeEvent,
  type GoalRuntimeProjection,
} from './index.js';

const projection = (overrides: Partial<GoalRuntimeProjection> = {}): GoalRuntimeProjection => ({
  contractVersion: 1,
  goalId: 'goal-1',
  workspaceId: 'workspace-1',
  lifecycleState: 'open',
  runtimeState: 'running',
  desiredRuntimeState: 'running',
  integrationState: 'not_started',
  workspaceState: 'clean',
  activeExecutionId: 'execution-3',
  executionGeneration: 3,
  lastActivityAt: '2026-09-21T12:00:00.000Z',
  ...overrides,
});

const event = (
  type: ExecutionScopedRuntimeEvent['type'],
  overrides: Partial<ExecutionScopedRuntimeEvent> = {},
): ExecutionScopedRuntimeEvent => ({
  eventId: 'event-1',
  type,
  workspaceId: 'workspace-1',
  goalId: 'goal-1',
  executionId: 'execution-3',
  executionGeneration: 3,
  occurredAt: '2026-09-21T12:00:01.000Z',
  ...overrides,
});

describe('Goal runtime event generation fence', () => {
  it('ignores stale worker events instead of mutating the newer generation', () => {
    expect(classifyGoalRuntimeEvent(
      projection(),
      event('execution_heartbeat', { executionId: 'execution-2', executionGeneration: 2 }),
    )).toEqual({ disposition: 'ignore', reason: 'stale_generation' });
  });

  it('rejects same-generation events carrying a different execution identity', () => {
    expect(classifyGoalRuntimeEvent(
      projection(),
      event('task_progress', { executionId: 'other-execution' }),
    )).toEqual({ disposition: 'reject', reason: 'execution_identity_mismatch' });
  });

  it('requires a submitted next generation before future execution activity is accepted', () => {
    expect(classifyGoalRuntimeEvent(
      projection(),
      event('execution_started', { executionId: 'execution-4', executionGeneration: 4 }),
    )).toEqual({ disposition: 'reject', reason: 'future_generation' });

    expect(classifyGoalRuntimeEvent(
      projection(),
      event('execution_submitted', { executionId: 'execution-4', executionGeneration: 4 }),
    )).toEqual({ disposition: 'apply' });
  });

  it('rejects generation gaps and accepts generation one only through submission', () => {
    expect(classifyGoalRuntimeEvent(
      projection(),
      event('execution_submitted', { executionId: 'execution-5', executionGeneration: 5 }),
    )).toEqual({ disposition: 'reject', reason: 'generation_gap' });

    const empty = { ...projection({
      runtimeState: 'idle',
      desiredRuntimeState: 'idle',
    }) };
    delete empty.activeExecutionId;
    delete empty.executionGeneration;
    expect(classifyGoalRuntimeEvent(
      empty,
      event('execution_started', { executionId: 'execution-1', executionGeneration: 1 }),
    )).toEqual({ disposition: 'reject', reason: 'execution_not_submitted' });
    expect(classifyGoalRuntimeEvent(
      empty,
      event('execution_submitted', { executionId: 'execution-1', executionGeneration: 1 }),
    )).toEqual({ disposition: 'apply' });
  });

  it('blocks late activity from a terminal execution generation', () => {
    expect(classifyGoalRuntimeEvent(
      projection({ runtimeState: 'failed' }),
      event('phase_started', { phase: 'test' }),
    )).toEqual({ disposition: 'reject', reason: 'terminal_generation' });
  });

  it('rejects late same-generation activity after a completed execution cleared active identity', () => {
    expect(classifyGoalRuntimeEvent(
      projection({ runtimeState: 'idle', desiredRuntimeState: 'idle', activeExecutionId: undefined }),
      event('task_progress'),
    )).toEqual({ disposition: 'reject', reason: 'terminal_generation' });

    expect(classifyGoalRuntimeEvent(
      projection({ runtimeState: 'idle', desiredRuntimeState: 'idle', activeExecutionId: undefined }),
      event('integration_started'),
    )).toEqual({ disposition: 'apply' });
  });

  it('does not let a closed Goal restart from an ordinary execution event', () => {
    expect(classifyGoalRuntimeEvent(
      projection({ lifecycleState: 'archived', runtimeState: 'idle', desiredRuntimeState: 'idle' }),
      event('execution_started'),
    )).toEqual({ disposition: 'reject', reason: 'goal_not_open' });
  });
});

describe('Goal runtime state transition validator', () => {
  it('keeps lifecycle terminal progression monotonic', () => {
    expect(validateGoalStateTransition({
      dimension: 'lifecycle',
      from: 'completed',
      to: 'archived',
    })).toEqual({ valid: true });
    expect(validateGoalStateTransition({
      dimension: 'lifecycle',
      from: 'archived',
      to: 'open',
    })).toEqual({ valid: false, reason: 'invalid_transition' });
    expect(validateGoalStateTransition({
      dimension: 'lifecycle',
      from: 'cleaned',
      to: 'open',
    })).toEqual({ valid: false, reason: 'invalid_transition' });
  });

  it('requires a new execution generation before terminal runtime can run again', () => {
    expect(validateGoalStateTransition({
      dimension: 'runtime',
      from: 'cancelled',
      to: 'running',
    })).toEqual({ valid: false, reason: 'invalid_transition' });
    expect(validateGoalStateTransition({
      dimension: 'runtime',
      from: 'cancelled',
      to: 'running',
      executionGenerationChanged: true,
    })).toEqual({ valid: true });
  });

  it('allows a newly fenced generation to replace an active runtime attempt', () => {
    expect(validateGoalStateTransition({
      dimension: 'runtime',
      from: 'running',
      to: 'queued',
      executionGenerationChanged: true,
    })).toEqual({ valid: true });
  });

  it('does not regress integrated state without a future integration-generation model', () => {
    expect(validateGoalStateTransition({
      dimension: 'integration',
      from: 'integrated',
      to: 'pending',
    })).toEqual({ valid: false, reason: 'invalid_transition' });
  });

  it('allows workspace observations to recover from missing to clean', () => {
    expect(validateGoalStateTransition({
      dimension: 'workspace',
      from: 'missing',
      to: 'clean',
    })).toEqual({ valid: true });
  });
});
