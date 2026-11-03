import { describe, expect, it } from 'vitest';
import { getClientScriptJs } from './ui/client-script.js';

type FakeNode = {
  textContent: string;
  innerHTML: string;
  className: string;
  title: string;
  value: number;
  max: number;
  scrollTop: number;
  scrollHeight: number;
  style: Record<string, string>;
  attrs: Record<string, string>;
  children: FakeNode[];
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | undefined;
  appendChild(child: FakeNode): void;
  replaceChildren(): void;
};

function fakeNode(): FakeNode {
  return {
    textContent: '',
    innerHTML: '',
    className: '',
    title: '',
    value: 0,
    max: 0,
    scrollTop: 0,
    scrollHeight: 0,
    style: {},
    attrs: {},
    children: [],
    setAttribute(name: string, value: string): void {
      this.attrs[name] = value;
    },
    getAttribute(name: string): string | undefined {
      return this.attrs[name];
    },
    appendChild(child: FakeNode): void {
      this.children.push(child);
    },
    replaceChildren(): void {
      this.children = [];
    },
  };
}

function extractFunction(script: string, name: string): string {
  const marker = `function ${name}(`;
  let start = script.indexOf(marker);
  if (start < 0) throw new Error(`function ${name} is missing from the client script`);
  if (script.slice(start - 6, start) === 'async ') start -= 6;
  const openParen = script.indexOf('(', start);
  let parenDepth = 0;
  let bodyStart = -1;
  for (let index = openParen; index < script.length; index += 1) {
    if (script[index] === '(') parenDepth += 1;
    else if (script[index] === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        bodyStart = script.indexOf('{', index);
        break;
      }
    }
  }
  let depth = 0;
  for (let index = bodyStart; index < script.length; index += 1) {
    if (script[index] === '{') depth += 1;
    else if (script[index] === '}') {
      depth -= 1;
      if (depth === 0) return script.slice(start, index + 1);
    }
  }
  throw new Error(`function ${name} is not balanced in the client script`);
}

const POLL_TIMEOUT_MS = 20;
const SETTLE_GUARD_MS = 2000;

type RecordedFetch = {
  urls: string[];
  fetchWithTimeout: (url: string, init?: RequestInit) => Promise<Response>;
  readJsonWithTimeout: (res: Response) => Promise<Record<string, unknown>>;
};

/**
 * Builds the shipped `fetchWithTimeout` against a controllable transport, and records every
 * helper call so a poller that reaches the network directly (bypassing the timeout) is visible.
 */
function recordedFetchWithTimeout(
  transport: (url: string, init: RequestInit) => Promise<Response>,
): RecordedFetch {
  const script = getClientScriptJs();
  // Both helpers must share one controller registry, exactly like the shipped pair.
  const factory = new Function(
    'fetch',
    `const REQUEST_TIMEOUT_MS = 8000;\n`
      + `const fetchControllers = new WeakMap();\n`
      + `${extractFunction(script, 'fetchWithTimeout')}\n`
      + `${extractFunction(script, 'readJsonWithTimeout')}\n`
      + `return { fetchWithTimeout, readJsonWithTimeout };`,
  );
  const real = factory(transport) as {
    fetchWithTimeout: (url: string, init: RequestInit, timeoutMs: number) => Promise<Response>;
    readJsonWithTimeout: (res: Response, timeoutMs: number) => Promise<Record<string, unknown>>;
  };
  const urls: string[] = [];
  return {
    urls,
    fetchWithTimeout: (url: string, init: RequestInit = {}): Promise<Response> => {
      urls.push(url);
      return real.fetchWithTimeout(url, init, POLL_TIMEOUT_MS);
    },
    readJsonWithTimeout: (res: Response): Promise<Record<string, unknown>> =>
      real.readJsonWithTimeout(res, POLL_TIMEOUT_MS),
  };
}

/** A transport that accepts the request and never answers, like a stalled control plane. */
function hangingTransport(): (url: string, init: RequestInit) => Promise<Response> {
  return (_url: string, init: RequestInit = {}): Promise<Response> =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });
}

function healthyStatusResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async (): Promise<Record<string, unknown>> => ({
      status: 'UP',
      gateway: {
        state: 'BRIDGE_HEALTHY',
        connectorRegistration: { state: 'registered' },
        endToEndState: 'verified',
        localPort: 18765,
      },
    }),
  } as unknown as Response;
}

function buildStatusSandbox(transport: (url: string, init: RequestInit) => Promise<Response>): {
  elements: Map<string, FakeNode>;
  recorded: RecordedFetch;
  backendUnavailable: Error[];
  loadStatus: () => Promise<void>;
} {
  const script = getClientScriptJs();
  const elements = new Map(
    ['build-commit', 'status-led', 'servers-telemetry', 'stat-loopback-port'].map((id) => [
      id,
      fakeNode(),
    ]),
  );
  const document = {
    getElementById: (id: string): FakeNode | null => elements.get(id) ?? null,
  };
  const recorded = recordedFetchWithTimeout(transport);
  const backendUnavailable: Error[] = [];
  const factory = new Function(
    'document',
    'fetchWithTimeout',
    'readJsonWithTimeout',
    'noteBackendUnavailable',
    'noteBackendAvailable',
    'logEvent',
    `${extractFunction(script, 'isRequestTimeout')}\n`
      + `${extractFunction(script, 'isBackendTransportError')}\n`
      + `let statusRefreshInFlight = false;\n`
      + `${extractFunction(script, 'loadStatus')}\nreturn loadStatus;`,
  );
  const loadStatus = factory(
    document,
    recorded.fetchWithTimeout,
    recorded.readJsonWithTimeout,
    (err: Error) => backendUnavailable.push(err),
    () => {},
    () => {},
  ) as () => Promise<void>;
  return { elements, recorded, backendUnavailable, loadStatus };
}

function buildRagIndexSandbox(transport: (url: string, init: RequestInit) => Promise<Response>): {
  container: FakeNode;
  recorded: RecordedFetch;
  loadRagIndexJobs: () => Promise<void>;
} {
  const script = getClientScriptJs();
  const container = fakeNode();
  const document = {
    getElementById: (id: string): FakeNode | null => (id === 'rag-index-jobs' ? container : null),
    createElement: (): FakeNode => fakeNode(),
  };
  const recorded = recordedFetchWithTimeout(transport);
  const factory = new Function(
    'document',
    'fetchWithTimeout',
    'readJsonWithTimeout',
    `let ragProgressInFlight = false;\n${extractFunction(script, 'loadRagIndexJobs')}\nreturn loadRagIndexJobs;`,
  );
  const loadRagIndexJobs = factory(
    document,
    recorded.fetchWithTimeout,
    recorded.readJsonWithTimeout,
  ) as () => Promise<void>;
  return { container, recorded, loadRagIndexJobs };
}

function buildRuntimeRefreshSandbox(
  transport: (url: string, init: RequestInit) => Promise<Response>,
): {
  recorded: RecordedFetch;
  backendUnavailable: Error[];
  runtime: Map<string, unknown>;
  runWorkspaceRuntimeRefresh: (workspaceId: string) => Promise<void>;
} {
  const script = getClientScriptJs();
  const recorded = recordedFetchWithTimeout(transport);
  const backendUnavailable: Error[] = [];
  const runtime = new Map<string, unknown>();
  const factory = new Function(
    'fetchWithTimeout',
    'readJsonWithTimeout',
    'isBackendTransportError',
    'noteBackendUnavailable',
    'logEvent',
    'errorMessage',
    'cachedWorkspaces',
    'workspaceRuntimeRefreshControllers',
    'workspaceRuntime',
    'applyWorkspaceRuntimeSnapshot',
    'renderWorkspaces',
    `${extractFunction(script, 'runWorkspaceRuntimeRefresh')}\nreturn runWorkspaceRuntimeRefresh;`,
  );
  const runWorkspaceRuntimeRefresh = factory(
    recorded.fetchWithTimeout,
    recorded.readJsonWithTimeout,
    () => true,
    (err: Error) => backendUnavailable.push(err),
    () => {},
    (_data: unknown, fallback: string) => fallback,
    [{ id: 'ws-1' }],
    new Map(),
    runtime,
    (workspaceId: string, data: unknown) => runtime.set(workspaceId, data),
    () => {},
  ) as (workspaceId: string) => Promise<void>;
  return { recorded, backendUnavailable, runtime, runWorkspaceRuntimeRefresh };
}

function buildMutationSandbox(
  transport: (url: string, init: RequestInit) => Promise<Response>,
): {
  recorded: RecordedFetch;
  toasts: string[];
  logs: string[];
  mutationJson: (url: string, init?: RequestInit) => Promise<{
    res: Response;
    data: Record<string, unknown>;
  }>;
} {
  const script = getClientScriptJs();
  const recorded = recordedFetchWithTimeout(transport);
  const toasts: string[] = [];
  const logs: string[] = [];
  const factory = new Function(
    'fetchWithTimeout',
    'readJsonWithTimeout',
    'showToast',
    'logEvent',
    'window',
    `${extractFunction(script, 'mutationJson')}\nreturn mutationJson;`,
  );
  const mutationJson = factory(
    recorded.fetchWithTimeout,
    recorded.readJsonWithTimeout,
    (message: string) => toasts.push(message),
    (level: string, message: string) => logs.push(level + ' ' + message),
    { location: { reload: () => {} } },
  ) as (url: string, init?: RequestInit) => Promise<{
    res: Response;
    data: Record<string, unknown>;
  }>;
  return { recorded, toasts, logs, mutationJson };
}

/** A response whose headers arrive immediately but whose body never settles. */
function stalledBodyResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: (): Promise<Record<string, unknown>> => new Promise<Record<string, unknown>>(() => {}),
  } as unknown as Response;
}

describe('background poll resilience', () => {
  it('releases the status in-flight guard after a hung poll times out', async () => {
    let hang = true;
    const transport = (url: string, init: RequestInit): Promise<Response> => {
      if (hang) return hangingTransport()(url, init);
      return Promise.resolve(healthyStatusResponse());
    };
    const { elements, recorded, loadStatus } = buildStatusSandbox(transport);

    await Promise.race([
      loadStatus(),
      new Promise((_resolve, reject) => {
        setTimeout(
          () => reject(new Error('a hung /api/status request wedged the status poller')),
          SETTLE_GUARD_MS,
        );
      }),
    ]);

    expect(recorded.urls).toEqual(['/api/status']);
    expect(elements.get('status-led')?.className).toBe('led offline');
    expect(elements.get('servers-telemetry')?.textContent).toContain(
      'Unable to reach backend: Request timed out after',
    );

    hang = false;
    await loadStatus();

    expect(recorded.urls).toEqual(['/api/status', '/api/status']);
    expect(elements.get('status-led')?.className).toBe('led');
    expect(elements.get('servers-telemetry')?.innerHTML).toContain('Control Plane Reachability');
    expect(elements.get('stat-loopback-port')?.textContent).toBe('18765');
  });

  it('does not wedge the in-flight guard on a failed status poll', async () => {
    let mode: 'healthy' | 'http-error' = 'healthy';
    const { elements, recorded, loadStatus } = buildStatusSandbox(async () => {
      if (mode === 'http-error') {
        return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
      }
      return healthyStatusResponse();
    });

    await loadStatus();
    expect(elements.get('status-led')?.className).toBe('led');

    mode = 'http-error';
    await loadStatus();
    expect(elements.get('status-led')?.className).toBe('led offline');
    expect(recorded.urls).toEqual(['/api/status', '/api/status']);

    await loadStatus();
    expect(recorded.urls).toEqual(['/api/status', '/api/status', '/api/status']);
  });

  it('reports unreadable index progress instead of freezing it when the poll hangs', async () => {
    let hang = true;
    const transport = (url: string, init: RequestInit): Promise<Response> => {
      if (hang) return hangingTransport()(url, init);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async (): Promise<Record<string, unknown>> => ({ available: true, jobs: [] }),
      } as unknown as Response);
    };
    const { container, recorded, loadRagIndexJobs } = buildRagIndexSandbox(transport);

    await Promise.race([
      loadRagIndexJobs(),
      new Promise((_resolve, reject) => {
        setTimeout(
          () => reject(new Error('a hung /api/rag-index-jobs request wedged index progress')),
          SETTLE_GUARD_MS,
        );
      }),
    ]);

    expect(recorded.urls).toEqual(['/api/rag-index-jobs']);
    expect(container.textContent).toBe('Unable to read native index progress');

    hang = false;
    await loadRagIndexJobs();

    expect(recorded.urls).toEqual(['/api/rag-index-jobs', '/api/rag-index-jobs']);
    expect(container.textContent).toBe('No native index jobs');
  });

  const unresponsiveTransports: [
    string,
    (url: string, init: RequestInit) => Promise<Response>,
  ][] = [
    ['a transport that never answers', hangingTransport()],
    ['a body that stalls mid-stream', (): Promise<Response> => Promise.resolve(stalledBodyResponse())],
  ];

  it.each(unresponsiveTransports)(
    'bounds the runtime diagnostics and server log polls when %s',
    async (_label, transport) => {
      const script = getClientScriptJs();
      const recorded = recordedFetchWithTimeout(transport);
      const texts: string[][] = [];
      const setText = (id: string, value: string): void => {
        texts.push([id, value]);
      };
      const document = {
        getElementById: (): FakeNode | null => fakeNode(),
      };
      const diagnosticsFactory = new Function(
        'document',
        'fetchWithTimeout',
        'readJsonWithTimeout',
        'setText',
        'formatBytes',
        'renderRuntimeRetention',
        'emptyRow',
        'errorMessage',
        `${extractFunction(script, 'loadRuntimeDiagnostics')}\nreturn loadRuntimeDiagnostics;`,
      );
      const loadRuntimeDiagnostics = diagnosticsFactory(
        document,
        recorded.fetchWithTimeout,
        recorded.readJsonWithTimeout,
        setText,
        () => '0 B',
        () => {},
        () => fakeNode(),
        () => 'unavailable',
      ) as () => Promise<void>;

      const logsFactory = new Function(
        'document',
        'fetchWithTimeout',
        'readJsonWithTimeout',
        'renderLogs',
        `let currentLogs = [];\n${extractFunction(script, 'fetchServerLogs')}\nreturn fetchServerLogs;`,
      );
      const fetchServerLogs = logsFactory(
        document,
        recorded.fetchWithTimeout,
        recorded.readJsonWithTimeout,
        () => {},
      ) as () => Promise<void>;

      await Promise.race([
        Promise.all([loadRuntimeDiagnostics(), fetchServerLogs()]),
        new Promise((_resolve, reject) => {
          setTimeout(
            () => reject(new Error('a hung diagnostics or log poll never settled')),
            SETTLE_GUARD_MS,
          );
        }),
      ]);

      expect(recorded.urls).toEqual(['/api/runtime-diagnostics', '/api/logs']);
      expect(texts).toContainEqual(['stat-runtime-rss', 'unavailable']);
      expect(texts).toContainEqual(['runtime-diagnostics-source', 'unavailable']);
    },
  );

  it('times out a response body that stalls mid-stream instead of pinning the guard', async () => {
    let stallBody = true;
    let abortedStalledRequest = false;
    const transport = (_url: string, init: RequestInit): Promise<Response> => {
      if (stallBody) {
        init.signal?.addEventListener('abort', () => {
          abortedStalledRequest = true;
        });
        return Promise.resolve({
          ok: true,
          status: 200,
          json: (): Promise<Record<string, unknown>> => new Promise<Record<string, unknown>>(() => {}),
        } as unknown as Response);
      }
      return Promise.resolve(healthyStatusResponse());
    };
    const { elements, recorded, loadStatus } = buildStatusSandbox(transport);

    await Promise.race([
      loadStatus(),
      new Promise((_resolve, reject) => {
        setTimeout(
          () => reject(new Error('a stalled response body wedged the status poller')),
          SETTLE_GUARD_MS,
        );
      }),
    ]);

    expect(recorded.urls).toEqual(['/api/status']);
    expect(elements.get('status-led')?.className).toBe('led offline');
    expect(elements.get('servers-telemetry')?.textContent).toContain(
      'Unable to reach backend: Response body timed out after',
    );
    // A locked body stream cannot be cancelled, so the deadline must abort the request
    // itself; otherwise every stalled poll holds its connection open.
    expect(abortedStalledRequest).toBe(true);

    stallBody = false;
    await loadStatus();

    expect(recorded.urls).toEqual(['/api/status', '/api/status']);
    expect(elements.get('status-led')?.className).toBe('led');
    expect(elements.get('stat-loopback-port')?.textContent).toBe('18765');
  });

  it('bounds the workspace-state read that a timeout reconciliation awaits', async () => {
    let stallBody = true;
    const transport = (): Promise<Response> =>
      Promise.resolve(stallBody ? stalledBodyResponse() : {
        ok: true,
        status: 200,
        json: async (): Promise<Record<string, unknown>> => ({ workspaces: [], selection: null }),
      } as unknown as Response);
    const recorded = recordedFetchWithTimeout(transport);
    const factory = new Function(
      'fetchWithTimeout',
      'readJsonWithTimeout',
      'errorMessage',
      `${extractFunction(getClientScriptJs(), 'fetchWorkspaceState')}\nreturn fetchWorkspaceState;`,
    );
    const fetchWorkspaceState = factory(
      recorded.fetchWithTimeout,
      recorded.readJsonWithTimeout,
      (_data: unknown, fallback: string) => fallback,
    ) as () => Promise<Record<string, unknown>>;

    await Promise.race([
      expect(fetchWorkspaceState()).rejects.toMatchObject({ code: 'request_timeout' }),
      new Promise((_resolve, reject) => {
        setTimeout(
          () => reject(new Error('a stalled /api/workspaces body wedged reconciliation')),
          SETTLE_GUARD_MS,
        );
      }),
    ]);

    expect(recorded.urls).toEqual(['/api/workspaces']);

    stallBody = false;
    await expect(fetchWorkspaceState()).resolves.toEqual({ workspaces: [], selection: null });
    expect(recorded.urls).toEqual(['/api/workspaces', '/api/workspaces']);
  });

  it('bounds the mutation body so a user action cannot hang after the headers arrive', async () => {
    let stallBody = true;
    const transport = (): Promise<Response> =>
      Promise.resolve(stallBody ? stalledBodyResponse() : {
        ok: true,
        status: 200,
        json: async (): Promise<Record<string, unknown>> => ({ ok: true, value: { updatedFiles: [] } }),
      } as unknown as Response);
    const { recorded, mutationJson } = buildMutationSandbox(transport);

    await Promise.race([
      expect(mutationJson('/api/policies/sync', { method: 'POST' })).rejects.toMatchObject({
        code: 'request_timeout',
      }),
      new Promise((_resolve, reject) => {
        setTimeout(
          () => reject(new Error('a stalled mutation body wedged the action')),
          SETTLE_GUARD_MS,
        );
      }),
    ]);

    expect(recorded.urls).toEqual(['/api/policies/sync']);

    stallBody = false;
    const { res, data } = await mutationJson('/api/policies/sync', { method: 'POST' });

    expect(res.ok).toBe(true);
    expect(data).toEqual({ ok: true, value: { updatedFiles: [] } });
    expect(recorded.urls).toEqual(['/api/policies/sync', '/api/policies/sync']);
  });

  it('settles a gateway stop action when the mutation body stalls', async () => {
    const transport = (): Promise<Response> => Promise.resolve(stalledBodyResponse());
    const { toasts, logs, mutationJson } = buildMutationSandbox(transport);
    const script = getClientScriptJs();
    const factory = new Function(
      'mutationJson',
      'showToast',
      'logEvent',
      'loadGatewayStatus',
      `${extractFunction(script, 'stopGateway')}\nreturn stopGateway;`,
    );
    const stopGateway = factory(
      mutationJson,
      (message: string) => toasts.push(message),
      (level: string, message: string) => logs.push(level + ' ' + message),
      () => {},
    ) as () => Promise<void>;

    await Promise.race([
      stopGateway(),
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('a stalled gateway stop never settled')), SETTLE_GUARD_MS);
      }),
    ]);

    expect(toasts.some((toast) => toast.includes('Response body timed out after'))).toBe(true);
    expect(logs.some((line) => line.startsWith('ERROR Stop gateway exception'))).toBe(true);
  });

  it('releases the goal-runtime refresh slot when a response body stalls mid-stream', async () => {
    let stallBody = true;
    const transport = (): Promise<Response> =>
      Promise.resolve(stallBody ? stalledBodyResponse() : {
        ok: true,
        status: 200,
        json: async (): Promise<Record<string, unknown>> => ({ snapshots: [], cursor: null }),
      } as unknown as Response);
    const { recorded, backendUnavailable, runtime, runWorkspaceRuntimeRefresh } =
      buildRuntimeRefreshSandbox(transport);

    await Promise.race([
      runWorkspaceRuntimeRefresh('ws-1'),
      new Promise((_resolve, reject) => {
        setTimeout(
          () => reject(new Error('a stalled goal-runtime body wedged its refresh slot')),
          SETTLE_GUARD_MS,
        );
      }),
    ]);

    expect(recorded.urls).toEqual(['/api/workspaces/ws-1/goal-runtime']);
    expect(backendUnavailable).toHaveLength(1);
    expect((backendUnavailable[0] as { code?: string }).code).toBe('request_timeout');
    expect(runtime.get('ws-1')).toMatchObject({
      error: expect.stringContaining('Response body timed out after'),
    });

    stallBody = false;
    await runWorkspaceRuntimeRefresh('ws-1');

    expect(recorded.urls).toEqual([
      '/api/workspaces/ws-1/goal-runtime',
      '/api/workspaces/ws-1/goal-runtime',
    ]);
    expect(runtime.get('ws-1')).toEqual({ snapshots: [], cursor: null });
  });

  it('releases the index-progress guard when a response body stalls mid-stream', async () => {
    let stallBody = true;
    const transport = (): Promise<Response> =>
      Promise.resolve(stallBody ? stalledBodyResponse() : {
        ok: true,
        status: 200,
        json: async (): Promise<Record<string, unknown>> => ({ available: true, jobs: [] }),
      } as unknown as Response);
    const { container, recorded, loadRagIndexJobs } = buildRagIndexSandbox(transport);

    await Promise.race([
      loadRagIndexJobs(),
      new Promise((_resolve, reject) => {
        setTimeout(
          () => reject(new Error('a stalled index-progress body wedged the poll')),
          SETTLE_GUARD_MS,
        );
      }),
    ]);

    expect(recorded.urls).toEqual(['/api/rag-index-jobs']);
    expect(container.textContent).toBe('Unable to read native index progress');

    stallBody = false;
    await loadRagIndexJobs();

    expect(recorded.urls).toEqual(['/api/rag-index-jobs', '/api/rag-index-jobs']);
    expect(container.textContent).toBe('No native index jobs');
  });

  it('classifies a request timeout as a backend transport failure', async () => {
    let mode: 'hang' | 'http-error' | 'healthy' = 'hang';
    const transport = (url: string, init: RequestInit): Promise<Response> => {
      if (mode === 'hang') return hangingTransport()(url, init);
      if (mode === 'http-error') {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);
      }
      return Promise.resolve(healthyStatusResponse());
    };
    const { backendUnavailable, loadStatus } = buildStatusSandbox(transport);

    await loadStatus();
    expect(backendUnavailable).toHaveLength(1);
    expect((backendUnavailable[0] as { code?: string }).code).toBe('request_timeout');

    mode = 'http-error';
    await loadStatus();
    expect(backendUnavailable).toHaveLength(1);

    mode = 'healthy';
    await loadStatus();
    expect(backendUnavailable).toHaveLength(1);
    expect(backendUnavailable[0]?.message).toContain('Request timed out after');
  });
});
