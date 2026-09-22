import {
  GOAL_RUNTIME_CONTRACT_VERSION,
  type GoalRuntimeEventRecord,
  type GoalRuntimeEventReplayPage,
  type GoalRuntimeSnapshotRecord,
  type ReplayWorkspaceGoalRuntimeEventsRequest,
} from '@unified-mpc/domain';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ControlPlaneServer,
  type GoalRuntimeReadPort,
  type WebWorkspaceSelectionSnapshot,
  type WebWorkspaceSummary,
  type WorkspaceControlPort,
} from './web-server.js';

const workspaceId = 'workspace-a';
const occurredAt = '2026-09-22T10:30:00.000Z';

const snapshot: GoalRuntimeSnapshotRecord = {
  projection: {
    contractVersion: GOAL_RUNTIME_CONTRACT_VERSION,
    goalId: 'goal-a',
    workspaceId,
    lifecycleState: 'open',
    runtimeState: 'running',
    desiredRuntimeState: 'running',
    integrationState: 'unknown',
    workspaceState: 'clean',
    activeExecutionId: 'execution-a',
    executionGeneration: 3,
    phase: 'test',
    lastActivityAt: occurredAt,
    lastHeartbeatAt: occurredAt,
  },
  lastEventSequence: 12,
  updatedAt: occurredAt,
};

const event11: GoalRuntimeEventRecord = {
  sequence: 11,
  event: {
    eventId: 'runtime-event-11',
    type: 'phase_started',
    workspaceId,
    goalId: 'goal-a',
    executionId: 'execution-a',
    executionGeneration: 3,
    phase: 'test',
    occurredAt,
  },
  recordedAt: occurredAt,
};

const event12: GoalRuntimeEventRecord = {
  sequence: 12,
  event: {
    eventId: 'runtime-event-12',
    type: 'execution_heartbeat',
    workspaceId,
    goalId: 'goal-a',
    executionId: 'execution-a',
    executionGeneration: 3,
    occurredAt: '2026-09-22T10:30:01.000Z',
  },
  recordedAt: '2026-09-22T10:30:01.000Z',
};

const event13: GoalRuntimeEventRecord = {
  sequence: 13,
  event: {
    eventId: 'runtime-event-13',
    type: 'task_progress',
    workspaceId,
    goalId: 'goal-a',
    executionId: 'execution-a',
    executionGeneration: 3,
    taskId: 'task-a',
    detail: '18/24 tests passed',
    occurredAt: '2026-09-22T10:30:02.000Z',
  },
  recordedAt: '2026-09-22T10:30:02.000Z',
};

function workspaceControl(): WorkspaceControlPort {
  const selection: WebWorkspaceSelectionSnapshot = {
    primaryWorkspaceId: workspaceId,
    activeWorkspaceIds: [workspaceId],
  };
  return {
    list: async (): Promise<readonly WebWorkspaceSummary[]> => [{
      id: workspaceId,
      displayName: 'Project A',
      rootPath: '/projects/a',
      realRootPath: '/projects/a',
    }],
    selection: async () => selection,
    activate: async () => selection,
    deactivate: async () => selection,
    setPrimary: async () => selection,
    remove: async () => selection,
  };
}

function runtimeRead(): GoalRuntimeReadPort {
  return {
    listWorkspaceGoalRuntimeSnapshots: async () => [snapshot],
    replayWorkspaceGoalRuntimeEvents: async (
      request: ReplayWorkspaceGoalRuntimeEventsRequest,
    ): Promise<GoalRuntimeEventReplayPage> => {
      if (request.afterSequence === undefined) {
        return {
          events: [event11],
          oldestAvailableSequence: 10,
          latestSequence: 12,
          replayWindowMissed: false,
        };
      }
      if (request.afterSequence === 1) {
        return {
          events: [event11, event12],
          oldestAvailableSequence: 10,
          latestSequence: 12,
          replayWindowMissed: true,
        };
      }
      if (request.afterSequence === 10) {
        return {
          events: [event11, event12],
          oldestAvailableSequence: 10,
          latestSequence: 12,
          replayWindowMissed: false,
        };
      }
      return {
        events: [],
        oldestAvailableSequence: 10,
        latestSequence: 12,
        replayWindowMissed: false,
      };
    },
  };
}

async function readSse(
  url: string,
  headers: Record<string, string>,
  complete: (body: string) => boolean,
): Promise<{ readonly status: number; readonly contentType: string | null; readonly body: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  timeout.unref?.();
  const response = await fetch(url, { headers, signal: controller.signal });
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('SSE response body is unavailable');
  const decoder = new TextDecoder();
  let body = '';
  try {
    while (!complete(body)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      body += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
  if (!complete(body)) throw new Error(`SSE predicate was not satisfied: ${body}`);
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body,
  };
}

describe('Goal runtime Web API and SSE boundary', () => {
  let server: ControlPlaneServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('serves bounded authoritative runtime snapshots with a durable event cursor', async () => {
    server = new ControlPlaneServer({
      port: 0,
      workspaceControl: workspaceControl(),
      goalRuntimeRead: runtimeRead(),
      goalRuntimeStreamPollMs: 25,
    });
    await server.listen();

    const response = await fetch(`http://127.0.0.1:${server.port}/api/workspaces/${workspaceId}/goal-runtime`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      workspaceId,
      snapshots: [snapshot],
      cursor: 12,
      latestSequence: 12,
      oldestAvailableSequence: 10,
    });
  });

  it('streams an initial snapshot, replays from Last-Event-ID, and refreshes when replay retention was missed', async () => {
    server = new ControlPlaneServer({
      port: 0,
      workspaceControl: workspaceControl(),
      goalRuntimeRead: runtimeRead(),
      goalRuntimeStreamPollMs: 25,
    });
    await server.listen();
    const url = `http://127.0.0.1:${server.port}/api/workspaces/${workspaceId}/goal-runtime/events`;

    const initial = await readSse(url, {}, (body) => body.includes('event: goal-runtime-snapshot'));
    expect(initial.status).toBe(200);
    expect(initial.contentType).toContain('text/event-stream');
    expect(initial.body).toContain('id: 12');
    expect(initial.body).toContain('"runtimeState":"running"');
    expect(initial.body).toContain('"replayWindowMissed":false');

    const replayed = await readSse(url, { 'Last-Event-ID': '10' }, (body) => body.includes('id: 12'));
    expect(replayed.body).not.toContain('event: goal-runtime-snapshot');
    expect(replayed.body).toContain('id: 11');
    expect(replayed.body).toContain('event: goal-runtime-event');
    expect(replayed.body).toContain('"type":"phase_started"');
    expect(replayed.body).toContain('"type":"execution_heartbeat"');

    const refreshed = await readSse(url, { 'Last-Event-ID': '1' }, (body) => body.includes('event: goal-runtime-snapshot'));
    expect(refreshed.body).toContain('id: 12');
    expect(refreshed.body).toContain('"replayWindowMissed":true');
    expect(refreshed.body).not.toContain('"eventId":"runtime-event-11"');
  });

  it('uses snapshot coverage as the SSE cursor so committed-but-unprojected events are not skipped', async () => {
    const laggingSnapshot: GoalRuntimeSnapshotRecord = {
      ...snapshot,
      lastEventSequence: 10,
      updatedAt: '2026-09-22T10:29:59.000Z',
    };
    const laggingRuntime: GoalRuntimeReadPort = {
      listWorkspaceGoalRuntimeSnapshots: async () => [laggingSnapshot],
      replayWorkspaceGoalRuntimeEvents: async (request) => {
        if (request.afterSequence === undefined) {
          return {
            events: [event11],
            oldestAvailableSequence: 10,
            latestSequence: 12,
            replayWindowMissed: false,
          };
        }
        if (request.afterSequence === 10) {
          return {
            events: [event11, event12],
            oldestAvailableSequence: 10,
            latestSequence: 12,
            replayWindowMissed: false,
          };
        }
        return {
          events: [],
          oldestAvailableSequence: 10,
          latestSequence: 12,
          replayWindowMissed: false,
        };
      },
    };

    server = new ControlPlaneServer({
      port: 0,
      workspaceControl: workspaceControl(),
      goalRuntimeRead: laggingRuntime,
      goalRuntimeStreamPollMs: 10,
    });
    await server.listen();

    const url = `http://127.0.0.1:${server.port}/api/workspaces/${workspaceId}/goal-runtime/events`;
    const streamed = await readSse(url, {}, (body) => body.includes('id: 12'));

    expect(streamed.body).toContain('event: goal-runtime-snapshot');
    expect(streamed.body).toContain('id: 10');
    expect(streamed.body).toContain('"lastEventSequence":10');
    expect(streamed.body).toContain('"eventId":"runtime-event-11"');
    expect(streamed.body).toContain('"eventId":"runtime-event-12"');
  });

  it('pushes newly durable events and stops polling after the client closes', async () => {
    let replayCalls = 0;
    let delivered = false;
    const liveRuntime: GoalRuntimeReadPort = {
      listWorkspaceGoalRuntimeSnapshots: async () => [snapshot],
      replayWorkspaceGoalRuntimeEvents: async (request) => {
        replayCalls += 1;
        if (request.afterSequence === undefined) {
          return {
            events: [event11],
            oldestAvailableSequence: 10,
            latestSequence: 12,
            replayWindowMissed: false,
          };
        }
        if (request.afterSequence === 12 && !delivered) {
          delivered = true;
          return {
            events: [event13],
            oldestAvailableSequence: 10,
            latestSequence: 13,
            replayWindowMissed: false,
          };
        }
        return {
          events: [],
          oldestAvailableSequence: 10,
          latestSequence: delivered ? 13 : 12,
          replayWindowMissed: false,
        };
      },
    };

    server = new ControlPlaneServer({
      port: 0,
      workspaceControl: workspaceControl(),
      goalRuntimeRead: liveRuntime,
      goalRuntimeStreamPollMs: 10,
    });
    await server.listen();
    const url = `http://127.0.0.1:${server.port}/api/workspaces/${workspaceId}/goal-runtime/events`;

    const streamed = await readSse(url, {}, (body) => body.includes('id: 13'));
    expect(streamed.body).toContain('event: goal-runtime-snapshot');
    expect(streamed.body).toContain('event: goal-runtime-event');
    expect(streamed.body).toContain('"eventId":"runtime-event-13"');

    await new Promise((resolve) => setTimeout(resolve, 30));
    const callsAfterDisconnect = replayCalls;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(replayCalls).toBe(callsAfterDisconnect);
  });

  it('stops initial SSE reads when the client disconnects before the first replay completes', async () => {
    let replayCalls = 0;
    let snapshotCalls = 0;
    let resolveReplay!: (page: GoalRuntimeEventReplayPage) => void;
    let signalReplayStarted!: () => void;
    const replayStarted = new Promise<void>((resolve) => {
      signalReplayStarted = resolve;
    });
    const pendingReplay = new Promise<GoalRuntimeEventReplayPage>((resolve) => {
      resolveReplay = resolve;
    });
    const disconnectRuntime: GoalRuntimeReadPort = {
      listWorkspaceGoalRuntimeSnapshots: async () => {
        snapshotCalls += 1;
        return [snapshot];
      },
      replayWorkspaceGoalRuntimeEvents: async () => {
        replayCalls += 1;
        if (replayCalls === 1) {
          signalReplayStarted();
          return pendingReplay;
        }
        return {
          events: [],
          oldestAvailableSequence: 10,
          latestSequence: 12,
          replayWindowMissed: false,
        };
      },
    };

    server = new ControlPlaneServer({
      port: 0,
      workspaceControl: workspaceControl(),
      goalRuntimeRead: disconnectRuntime,
      goalRuntimeStreamPollMs: 10,
    });
    await server.listen();
    const url = `http://127.0.0.1:${server.port}/api/workspaces/${workspaceId}/goal-runtime/events`;
    const controller = new AbortController();
    const request = fetch(url, { signal: controller.signal }).catch(() => undefined);

    await replayStarted;
    controller.abort();
    await request;
    await new Promise((resolve) => setTimeout(resolve, 25));

    resolveReplay({
      events: [event11],
      oldestAvailableSequence: 10,
      latestSequence: 12,
      replayWindowMissed: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(replayCalls).toBe(1);
    expect(snapshotCalls).toBe(0);
  });

  it('rejects malformed SSE replay cursors before opening a stream', async () => {
    server = new ControlPlaneServer({
      port: 0,
      workspaceControl: workspaceControl(),
      goalRuntimeRead: runtimeRead(),
    });
    await server.listen();

    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/workspaces/${workspaceId}/goal-runtime/events`,
      { headers: { 'Last-Event-ID': 'not-a-sequence' } },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Last-Event-ID must be a non-negative integer',
    });
  });
});
