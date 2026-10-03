import { connect } from 'node:net';
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

const admissionProjection = {
  runtime: {
    source: 'last_admitted' as const,
    deploymentId: 'deploy-7',
    generation: 'generation-7',
    buildVersion: '4.61.0+0123456789ab',
    buildCommit: '0123456789abcdef0123456789abcdef01234567',
    buildDirty: false,
    protocolGeneration: 1,
    startedAt: '2026-09-23T00:00:00.000Z',
  },
  workspace: {
    id: workspaceId,
    kind: 'git' as const,
    branch: 'goal/one',
    expectedHead: 'a'.repeat(40),
    observedHead: 'a'.repeat(40),
    dirtyState: 'clean' as const,
  },
  base: {
    ref: 'main',
    recordedSha: 'b'.repeat(40),
    currentResolvedSha: 'b'.repeat(40),
    freshness: 'current' as const,
  },
  ownership: { goalId: 'goal-a', writeLeaseGeneration: 3 },
  admission: { status: 'ADMITTED' as const, generation: 2, remediation: 'none' as const },
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

function workspaceControlFor(workspaceIds: readonly string[]): WorkspaceControlPort {
  const selection: WebWorkspaceSelectionSnapshot = {
    primaryWorkspaceId: workspaceIds[0] ?? '',
    activeWorkspaceIds: [...workspaceIds],
  };
  return {
    list: async () => workspaceIds.map((id, index) => ({
      id,
      displayName: `Project ${index + 1}`,
      rootPath: `/projects/${index + 1}`,
      realRootPath: `/projects/${index + 1}`,
    })),
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
      goalRuntimeRead: {
        ...runtimeRead(),
        readWorkspaceAdmissionProjection: async () => admissionProjection,
      } as unknown as GoalRuntimeReadPort,
      goalRuntimeStreamPollMs: 25,
    });
    await server.listen();

    const response = await fetch(`http://127.0.0.1:${server.port}/api/workspaces/${workspaceId}/goal-runtime`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toEqual({
      workspaceId,
      snapshots: [snapshot],
      admission: admissionProjection,
      cursor: 12,
      latestSequence: 12,
      oldestAvailableSequence: 10,
    });
    expect(JSON.stringify(body)).not.toContain('repositoryIdentity');
    expect(JSON.stringify(body)).not.toContain('dirtyFingerprint');
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

  it('multiplexes 50 workspaces through one shared replay loop', async () => {
    const workspaceIds = Array.from({ length: 50 }, (_, index) => `workspace-${index + 1}`);
    let replayCalls = 0;
    let delivered = false;
    const liveEvent: GoalRuntimeEventRecord = {
      ...event13,
      sequence: 13,
      event: {
        ...event13.event,
        eventId: 'runtime-event-multiplexed',
        workspaceId: workspaceIds[49]!,
        goalId: 'goal-50',
      },
    };
    const multiplexedRuntime: GoalRuntimeReadPort = {
      listWorkspaceGoalRuntimeSnapshots: async (request) => [{
        ...snapshot,
        projection: {
          ...snapshot.projection,
          workspaceId: request.workspaceId,
          goalId: 'goal-' + request.workspaceId.split('-').at(-1),
        },
      }],
      replayWorkspaceGoalRuntimeEvents: runtimeRead().replayWorkspaceGoalRuntimeEvents,
      replayGoalRuntimeEvents: async (request) => {
        replayCalls += 1;
        const latest = delivered ? 13 : 12;
        const workspaceBounds = request.workspaceIds.map((id) => ({
          workspaceId: id,
          oldestAvailableSequence: 10,
          latestSequence: id === workspaceIds[49] && delivered ? 13 : 12,
        }));
        if (request.afterSequence === 12 && !delivered) {
          delivered = true;
          return {
            events: [liveEvent],
            oldestAvailableSequence: 10,
            latestSequence: 13,
            replayWindowMissed: false,
            workspaceBounds: workspaceBounds.map((bound) => bound.workspaceId === workspaceIds[49]
              ? { ...bound, latestSequence: 13 }
              : bound),
          };
        }
        return {
          events: [],
          oldestAvailableSequence: 10,
          latestSequence: latest,
          replayWindowMissed: false,
          workspaceBounds,
        };
      },
    };

    server = new ControlPlaneServer({
      port: 0,
      workspaceControl: workspaceControlFor(workspaceIds),
      goalRuntimeRead: multiplexedRuntime,
      goalRuntimeStreamPollMs: 10,
    });
    await server.listen();

    const streamed = await readSse(
      `http://127.0.0.1:${server.port}/api/goal-runtime/events`,
      {},
      (body) => body.includes('runtime-event-multiplexed'),
    );
    expect((streamed.body.match(/event: goal-runtime-snapshot/g) ?? []).length).toBe(50);
    expect(streamed.body).toContain('"workspaceId":"workspace-50"');
    expect(streamed.body).toContain('event: goal-runtime-event');
    expect(replayCalls).toBeLessThan(6);

    await new Promise((resolve) => setTimeout(resolve, 30));
    const callsAfterDisconnect = replayCalls;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(replayCalls).toBe(callsAfterDisconnect);
  });

  it('advances a fully covered multiplexed snapshot to the global latest sequence', async () => {
    const workspaceIds = ['workspace-old', 'workspace-new'];
    const multiplexedRuntime: GoalRuntimeReadPort = {
      listWorkspaceGoalRuntimeSnapshots: async (request) => [{
        ...snapshot,
        lastEventSequence: request.workspaceId === 'workspace-old' ? 12 : 120,
        projection: {
          ...snapshot.projection,
          workspaceId: request.workspaceId,
          goalId: 'goal-' + request.workspaceId,
        },
      }],
      replayWorkspaceGoalRuntimeEvents: runtimeRead().replayWorkspaceGoalRuntimeEvents,
      replayGoalRuntimeEvents: async (request) => ({
        events: [],
        oldestAvailableSequence: 10,
        latestSequence: 120,
        replayWindowMissed: false,
        workspaceBounds: request.workspaceIds.map((id) => id === 'workspace-old'
          ? { workspaceId: id, oldestAvailableSequence: 10, latestSequence: 12 }
          : { workspaceId: id, oldestAvailableSequence: 100, latestSequence: 120 }),
      }),
    };

    server = new ControlPlaneServer({
      port: 0,
      workspaceControl: workspaceControlFor(workspaceIds),
      goalRuntimeRead: multiplexedRuntime,
      goalRuntimeStreamPollMs: 20,
    });
    await server.listen();

    const streamed = await readSse(
      `http://127.0.0.1:${server.port}/api/goal-runtime/events`,
      {},
      (body) => (body.match(/event: goal-runtime-snapshot/g) ?? []).length >= 2,
    );
    expect(streamed.body).toContain('id: 120');
    expect(streamed.body).not.toContain('id: 12\\n');
  });

  it('does not loop snapshots when another workspace retained floor is ahead of the catch-up cursor', async () => {
    const workspaceIds = ['workspace-lagging', 'workspace-new'];
    const lagEvent11: GoalRuntimeEventRecord = {
      ...event11,
      event: { ...event11.event, workspaceId: workspaceIds[0]!, goalId: 'goal-lagging' },
    };
    const lagEvent12: GoalRuntimeEventRecord = {
      ...event12,
      event: { ...event12.event, workspaceId: workspaceIds[0]!, goalId: 'goal-lagging' },
    };
    const newEvent120: GoalRuntimeEventRecord = {
      ...event13,
      sequence: 120,
      event: {
        ...event13.event,
        eventId: 'runtime-event-120',
        workspaceId: workspaceIds[1]!,
        goalId: 'goal-new',
      },
    };
    let replayCalls = 0;
    const multiplexedRuntime: GoalRuntimeReadPort = {
      listWorkspaceGoalRuntimeSnapshots: async (request) => [{
        ...snapshot,
        lastEventSequence: request.workspaceId === workspaceIds[0] ? 10 : 120,
        projection: {
          ...snapshot.projection,
          workspaceId: request.workspaceId,
          goalId: request.workspaceId === workspaceIds[0] ? 'goal-lagging' : 'goal-new',
        },
      }],
      replayWorkspaceGoalRuntimeEvents: runtimeRead().replayWorkspaceGoalRuntimeEvents,
      replayGoalRuntimeEvents: async (request) => {
        replayCalls += 1;
        const workspaceBounds = [
          { workspaceId: workspaceIds[0]!, oldestAvailableSequence: 10, latestSequence: 12 },
          { workspaceId: workspaceIds[1]!, oldestAvailableSequence: 100, latestSequence: 120 },
        ];
        if (request.afterSequence === 10) {
          return {
            events: [lagEvent11, lagEvent12, newEvent120],
            oldestAvailableSequence: 10,
            latestSequence: 120,
            replayWindowMissed: true,
            workspaceBounds,
          };
        }
        return {
          events: [],
          oldestAvailableSequence: 10,
          latestSequence: 120,
          replayWindowMissed: false,
          workspaceBounds,
        };
      },
    };

    server = new ControlPlaneServer({
      port: 0,
      workspaceControl: workspaceControlFor(workspaceIds),
      goalRuntimeRead: multiplexedRuntime,
      goalRuntimeStreamPollMs: 5,
    });
    await server.listen();

    const streamed = await readSse(
      `http://127.0.0.1:${server.port}/api/goal-runtime/events`,
      {},
      (body) => body.includes('runtime-event-120')
        || (body.match(/event: goal-runtime-snapshot/g) ?? []).length > 4,
    );
    expect(streamed.body).toContain('runtime-event-120');
    expect(replayCalls).toBeLessThan(6);
  });

  it('times out one stalled workspace snapshot without freezing multiplexed realtime', async () => {
    const workspaceIds = ['workspace-ok', 'workspace-stalled', 'workspace-ok-2'];
    const stalled = new Promise<readonly GoalRuntimeSnapshotRecord[]>(() => undefined);
    const multiplexedRuntime: GoalRuntimeReadPort = {
      listWorkspaceGoalRuntimeSnapshots: async (request) => {
        if (request.workspaceId === 'workspace-stalled') return stalled;
        return [{
          ...snapshot,
          projection: {
            ...snapshot.projection,
            workspaceId: request.workspaceId,
            goalId: 'goal-' + request.workspaceId,
          },
        }];
      },
      replayWorkspaceGoalRuntimeEvents: runtimeRead().replayWorkspaceGoalRuntimeEvents,
      replayGoalRuntimeEvents: async (request) => ({
        events: [],
        replayWindowMissed: false,
        workspaceBounds: request.workspaceIds.map((id) => ({ workspaceId: id })),
      }),
    };

    server = new ControlPlaneServer({
      port: 0,
      workspaceControl: workspaceControlFor(workspaceIds),
      goalRuntimeRead: multiplexedRuntime,
      goalRuntimeStreamPollMs: 20,
      goalRuntimeStreamReadTimeoutMs: 25,
    });
    await server.listen();

    const streamed = await readSse(
      `http://127.0.0.1:${server.port}/api/goal-runtime/events`,
      {},
      (body) => body.includes('goal-runtime-stream-error') && body.includes('workspace-ok-2'),
    );
    expect(streamed.body).toContain('"workspaceId":"workspace-ok"');
    expect(streamed.body).toContain('"workspaceId":"workspace-stalled"');
    expect(streamed.body).toContain('preserving bounded realtime for other projects');
  });

  it('bounds shutdown when a browser leaves a lingering HTTP connection open', async () => {
    server = new ControlPlaneServer({
      port: 0,
      workspaceControl: workspaceControl(),
      goalRuntimeRead: runtimeRead(),
      serverShutdownGraceMs: 25,
    });
    await server.listen();

    const socket = connect(server.port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n');

    const startedAt = Date.now();
    await server.close();
    server = undefined;

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(socket.destroyed).toBe(true);
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
