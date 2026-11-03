import { describe, expect, it } from 'vitest';
import { getClientScriptJs, transitionBackendConnectionState } from './ui/client-script.js';

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
  dataset: Record<string, string>;
  children: FakeNode[];
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | undefined;
  appendChild(child: FakeNode): void;
  replaceChildren(...nodes: FakeNode[]): void;
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
    dataset: {},
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
    replaceChildren(...nodes: FakeNode[]): void {
      this.children = nodes;
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

/**
 * Wires the shipped availability helpers, `loadStatus`, `loadGatewayStatus` and the
 * per-workspace goal-runtime refresh into one scope, so a test can observe what a
 * single stalled endpoint does to the shared log.
 */
function buildAvailabilitySandbox(transport: (url: string, init: RequestInit) => Promise<Response>): {
  recorded: RecordedFetch;
  logs: string[];
  loadStatus: () => Promise<void>;
  loadGatewayStatus: () => Promise<void>;
  runWorkspaceRuntimeRefresh: (workspaceId: string) => Promise<void>;
  syncWorkspaceRuntimeStreams: () => void;
  clearWorkspaceRuntimeState: (workspaceId: string) => void;
  setCachedWorkspaces: (ids: string[]) => void;
} {
  const script = getClientScriptJs();
  const recorded = recordedFetchWithTimeout(transport);
  const logs: string[] = [];
  const document = { getElementById: (): null => null };
  function FakeEventSource(): void {
    // The stream itself is not under test; only the per-workspace bookkeeping around it.
  }
  FakeEventSource.prototype.addEventListener = (): void => {};
  FakeEventSource.prototype.close = (): void => {};
  const factory = new Function(
    'fetchWithTimeout',
    'readJsonWithTimeout',
    'document',
    'logEvent',
    'console',
    'renderGatewayUnavailable',
    'transitionBackendConnectionState',
    'errorMessage',
    'applyWorkspaceRuntimeSnapshot',
    'renderWorkspaces',
    'EventSource',
    'refreshWorkspaceRuntime',
    'noteWorkspaceRuntimeEvent',
    `let backendConnectionState = 'unknown';\n`
      + `const endpointConnectionStates = new Map();\n`
      + `let statusRefreshInFlight = false;\n`
      + `let gatewayStatusSeq = 0;\n`
      + `let gatewayStatusAppliedSeq = 0;\n`
      + `let cachedWorkspaces = [{ id: 'ws-1' }, { id: 'ws-2' }];\n`
      + `function setCachedWorkspaces(ids) { cachedWorkspaces = ids.map(function (id) { return { id: id }; }); }\n`
      + `const workspaceRuntimeRefreshControllers = new Map();\n`
      + `const workspaceRuntimeRefreshPending = new Map();\n`
      + `const workspaceRuntimeTargets = new Map();\n`
      + `const workspaceRuntimeCatchupAttempts = new Map();\n`
      + `const workspaceRuntimeCatchupTimers = new Map();\n`
      + `const workspaceRuntime = new Map();\n`
      + `let workspaceRuntimeStream = null;\n`
      + `let workspaceRuntimeStreamWorkspaceKey = '';\n`
      + `let workspaceRuntimeFallbackTimer = null;\n`
      + `let workspaceRuntimeFallbackIndex = 0;\n`
      + `${extractFunction(script, 'isRequestTimeout')}\n`
      + `${extractFunction(script, 'isBackendTransportError')}\n`
      + `${extractFunction(script, 'noteBackendUnavailable')}\n`
      + `${extractFunction(script, 'noteBackendAvailable')}\n`
      + `${extractFunction(script, 'noteEndpointUnavailable')}\n`
      + `${extractFunction(script, 'noteEndpointAvailable')}\n`
      + `${extractFunction(script, 'pruneWorkspaceEndpointStates')}\n`
      + `${extractFunction(script, 'stopWorkspaceRuntimeFallback')}\n`
      + `${extractFunction(script, 'scheduleWorkspaceRuntimeFallback')}\n`
      + `${extractFunction(script, 'closeWorkspaceRuntimeStream')}\n`
      + `${extractFunction(script, 'clearWorkspaceRuntimeState')}\n`
      + `${extractFunction(script, 'syncWorkspaceRuntimeStreams')}\n`
      + `${extractFunction(script, 'loadStatus')}\n`
      + `${extractFunction(script, 'loadGatewayStatus')}\n`
      + `${extractFunction(script, 'runWorkspaceRuntimeRefresh')}\n`
      + `return { loadStatus, loadGatewayStatus, runWorkspaceRuntimeRefresh, syncWorkspaceRuntimeStreams, clearWorkspaceRuntimeState, setCachedWorkspaces };`,
  );
  const built = factory(
    recorded.fetchWithTimeout,
    recorded.readJsonWithTimeout,
    document,
    (level: string, message: string) => logs.push(level + ' ' + message),
    { error: () => {} },
    () => {},
    transitionBackendConnectionState,
    (_data: unknown, fallback: string) => fallback,
    () => {},
    () => {},
    FakeEventSource,
    () => Promise.resolve(),
    () => {},
  ) as {
    loadStatus: () => Promise<void>;
    loadGatewayStatus: () => Promise<void>;
    runWorkspaceRuntimeRefresh: (workspaceId: string) => Promise<void>;
    syncWorkspaceRuntimeStreams: () => void;
    clearWorkspaceRuntimeState: (workspaceId: string) => void;
    setCachedWorkspaces: (ids: string[]) => void;
  };
  return {
    recorded,
    logs,
    loadStatus: built.loadStatus,
    loadGatewayStatus: built.loadGatewayStatus,
    runWorkspaceRuntimeRefresh: built.runWorkspaceRuntimeRefresh,
    syncWorkspaceRuntimeStreams: built.syncWorkspaceRuntimeStreams,
    clearWorkspaceRuntimeState: built.clearWorkspaceRuntimeState,
    setCachedWorkspaces: built.setCachedWorkspaces,
  };
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
  endpointUnavailable: Array<{ endpoint: string; error: Error }>;
  endpointAvailable: string[];
  runtime: Map<string, unknown>;
  runWorkspaceRuntimeRefresh: (workspaceId: string) => Promise<void>;
} {
  const script = getClientScriptJs();
  const recorded = recordedFetchWithTimeout(transport);
  const backendUnavailable: Error[] = [];
  const endpointUnavailable: Array<{ endpoint: string; error: Error }> = [];
  const endpointAvailable: string[] = [];
  const runtime = new Map<string, unknown>();
  const factory = new Function(
    'fetchWithTimeout',
    'readJsonWithTimeout',
    'isBackendTransportError',
    'noteBackendUnavailable',
    'noteEndpointUnavailable',
    'noteEndpointAvailable',
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
    (endpoint: string, error: Error) => endpointUnavailable.push({ endpoint, error }),
    (endpoint: string) => endpointAvailable.push(endpoint),
    () => {},
    (_data: unknown, fallback: string) => fallback,
    [{ id: 'ws-1' }],
    new Map(),
    runtime,
    (workspaceId: string, data: unknown) => runtime.set(workspaceId, data),
    () => {},
  ) as (workspaceId: string) => Promise<void>;
  return {
    recorded,
    backendUnavailable,
    endpointUnavailable,
    endpointAvailable,
    runtime,
    runWorkspaceRuntimeRefresh,
  };
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

/** A document that hands back the elements a boot read touches. */
function bootDocument(ids: string[]): {
  elements: Map<string, FakeNode>;
  document: { getElementById(id: string): FakeNode | null; createElement(): FakeNode };
} {
  const elements = new Map(ids.map((id) => [id, fakeNode()]));
  return {
    elements,
    document: {
      getElementById: (id: string): FakeNode | null => elements.get(id) ?? null,
      createElement: (): FakeNode => fakeNode(),
    },
  };
}

function buildSettingsSandbox(transport: (url: string, init: RequestInit) => Promise<Response>): {
  elements: Map<string, FakeNode>;
  recorded: RecordedFetch;
  logs: string[];
  loadSettings: () => Promise<void>;
} {
  const script = getClientScriptJs();
  const { elements, document } = bootDocument(['settings-persistence-status']);
  const recorded = recordedFetchWithTimeout(transport);
  const logs: string[] = [];
  const factory = new Function(
    'document',
    'fetchWithTimeout',
    'readJsonWithTimeout',
    'logEvent',
    `${extractFunction(script, 'loadSettings')}\nreturn loadSettings;`,
  );
  const loadSettings = factory(
    document,
    recorded.fetchWithTimeout,
    recorded.readJsonWithTimeout,
    (level: string, message: string) => logs.push(level + ' ' + message),
  ) as () => Promise<void>;
  return { elements, recorded, logs, loadSettings };
}

function buildGoalsSandbox(transport: (url: string, init: RequestInit) => Promise<Response>): {
  recorded: RecordedFetch;
  logs: string[];
  workspaceGoals: Map<string, { goals: unknown[]; preferredGoalId: string | null; error: string | null }>;
  loadingWorkspaceGoals: Set<string>;
  loadWorkspaceGoals: (workspaceId: string) => Promise<void>;
} {
  const script = getClientScriptJs();
  const recorded = recordedFetchWithTimeout(transport);
  const logs: string[] = [];
  const loadingWorkspaceGoals = new Set<string>();
  const workspaceGoals = new Map<
    string,
    { goals: unknown[]; preferredGoalId: string | null; error: string | null }
  >();
  const factory = new Function(
    'fetchWithTimeout',
    'readJsonWithTimeout',
    'errorMessage',
    'logEvent',
    'workspaceGoals',
    'loadingWorkspaceGoals',
    'renderWorkspaces',
    `${extractFunction(script, 'loadWorkspaceGoals')}\nreturn loadWorkspaceGoals;`,
  );
  const loadWorkspaceGoals = factory(
    recorded.fetchWithTimeout,
    recorded.readJsonWithTimeout,
    (_data: unknown, fallback: string) => fallback,
    (level: string, message: string) => logs.push(level + ' ' + message),
    workspaceGoals,
    loadingWorkspaceGoals,
    () => {},
  ) as (workspaceId: string) => Promise<void>;
  return { recorded, logs, workspaceGoals, loadingWorkspaceGoals, loadWorkspaceGoals };
}

function buildInventorySandbox(transport: (url: string, init: RequestInit) => Promise<Response>): {
  elements: Map<string, FakeNode>;
  recorded: RecordedFetch;
  logs: string[];
  loadInventory: () => Promise<void>;
} {
  const script = getClientScriptJs();
  const { elements, document } = bootDocument([
    'server-table-body',
    'skill-table-body',
    'server-table-detailed-body',
    'skill-table-detailed-body',
    'canonical-server-diagnostics-body',
    'canonical-skill-diagnostics-body',
    'stat-servers-count',
    'stat-skills-count',
  ]);
  const recorded = recordedFetchWithTimeout(transport);
  const logs: string[] = [];
  const factory = new Function(
    'document',
    'fetchWithTimeout',
    'readJsonWithTimeout',
    'logEvent',
    'renderServerTables',
    'renderSkillTables',
    'renderCanonicalExtensionDiagnostics',
    `let cachedServers = [];\n`
      + `let cachedSkills = [];\n`
      + `let cachedCanonicalExtensions = null;\n`
      + `${extractFunction(script, 'emptyRow')}\n`
      + `${extractFunction(script, 'loadInventory')}\nreturn loadInventory;`,
  );
  const loadInventory = factory(
    document,
    recorded.fetchWithTimeout,
    recorded.readJsonWithTimeout,
    (level: string, message: string) => logs.push(level + ' ' + message),
    () => {},
    () => {},
    () => {},
  ) as () => Promise<void>;
  return { elements, recorded, logs, loadInventory };
}

function buildPanelReadSandbox(
  transport: (url: string, init: RequestInit) => Promise<Response>,
  functionName: 'loadPolicies' | 'loadCleanupEvaluations',
  ids: string[],
): {
  elements: Map<string, FakeNode>;
  recorded: RecordedFetch;
  logs: string[];
  read: () => Promise<void>;
} {
  const script = getClientScriptJs();
  const { elements, document } = bootDocument(ids);
  const recorded = recordedFetchWithTimeout(transport);
  const logs: string[] = [];
  const factory = new Function(
    'document',
    'fetchWithTimeout',
    'readJsonWithTimeout',
    'errorMessage',
    'logEvent',
    'cachedPolicies',
    'renderPolicyTables',
    `${extractFunction(script, 'emptyRow')}\n`
      + `${extractFunction(script, functionName)}\nreturn ${functionName};`,
  );
  const read = factory(
    document,
    recorded.fetchWithTimeout,
    recorded.readJsonWithTimeout,
    (_data: unknown, fallback: string) => fallback,
    (level: string, message: string) => logs.push(level + ' ' + message),
    [],
    () => {},
  ) as () => Promise<void>;
  return { elements, recorded, logs, read };
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
    const { recorded, backendUnavailable, endpointUnavailable, endpointAvailable, runtime, runWorkspaceRuntimeRefresh } =
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
    expect(backendUnavailable).toHaveLength(0);
    expect(endpointUnavailable).toHaveLength(1);
    expect(endpointUnavailable[0]?.endpoint).toBe('Project goal runtime');
    expect((endpointUnavailable[0]?.error as { code?: string }).code).toBe('request_timeout');
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
    expect(endpointAvailable).toEqual(['Project goal runtime']);
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

  it('logs a gateway-only outage once instead of once per status cycle', async () => {
    let statusMode: 'healthy' | 'stalled' = 'healthy';
    let gatewayMode: 'healthy' | 'stalled' = 'stalled';
    const transport = (url: string): Promise<Response> => {
      if (url === '/api/status') {
        return Promise.resolve(statusMode === 'healthy' ? healthyStatusResponse() : stalledBodyResponse());
      }
      return Promise.resolve(
        gatewayMode === 'healthy'
          ? ({
              ok: true,
              status: 200,
              json: async (): Promise<Record<string, unknown>> => ({ state: 'BRIDGE_HEALTHY' }),
            } as unknown as Response)
          : stalledBodyResponse(),
      );
    };
    const { logs, loadStatus, loadGatewayStatus } = buildAvailabilitySandbox(transport);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await loadStatus();
      await loadGatewayStatus();
    }

    expect(logs.filter((line) => line.startsWith('ERROR'))).toEqual([
      'ERROR ChatGPT gateway unavailable: Response body timed out after 20ms',
    ]);
    expect(logs.some((line) => line.includes('Backend unavailable'))).toBe(false);
    expect(logs.some((line) => line.startsWith('SUCCESS'))).toBe(false);

    gatewayMode = 'healthy';
    await loadGatewayStatus();
    await loadGatewayStatus();
    expect(logs.filter((line) => line.startsWith('SUCCESS'))).toEqual([
      'SUCCESS ChatGPT gateway restored',
    ]);

    statusMode = 'stalled';
    gatewayMode = 'stalled';
    await loadStatus();
    await loadStatus();
    await loadGatewayStatus();

    expect(logs.filter((line) => line.includes('Backend unavailable'))).toEqual([
      'ERROR Backend unavailable: Response body timed out after 20ms',
    ]);
    // The probe already reported the outage; the stalled endpoint adds nothing.
    expect(logs.filter((line) => line.includes('ChatGPT gateway unavailable'))).toHaveLength(1);

    // Once the probe recovers, a gateway that is still stalled is reported again:
    // the suppression must not swallow the endpoint's own outage for good.
    statusMode = 'healthy';
    await loadStatus();
    await loadGatewayStatus();

    expect(logs.filter((line) => line.includes('ChatGPT gateway unavailable'))).toHaveLength(2);
    expect(logs.filter((line) => line.startsWith('SUCCESS'))).toEqual([
      'SUCCESS ChatGPT gateway restored',
      'SUCCESS Backend connection restored',
    ]);
  });

  it('keeps a healthy project from reporting recovery for a stalled sibling', async () => {
    let siblingMode: 'healthy' | 'stalled' = 'stalled';
    const healthyRuntime = (): Response =>
      ({
        ok: true,
        status: 200,
        json: async (): Promise<Record<string, unknown>> => ({ snapshots: [], cursor: null }),
      } as unknown as Response);
    const transport = (url: string): Promise<Response> => {
      if (url === '/api/workspaces/ws-2/goal-runtime') {
        return Promise.resolve(siblingMode === 'stalled' ? stalledBodyResponse() : healthyRuntime());
      }
      return Promise.resolve(healthyRuntime());
    };
    const {
      logs,
      runWorkspaceRuntimeRefresh,
      syncWorkspaceRuntimeStreams,
      clearWorkspaceRuntimeState,
      setCachedWorkspaces,
    } = buildAvailabilitySandbox(transport);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await runWorkspaceRuntimeRefresh('ws-1');
      await runWorkspaceRuntimeRefresh('ws-2');
    }

    expect(logs.filter((line) => line.startsWith('ERROR'))).toEqual([
      'ERROR Project goal runtime unavailable: Response body timed out after 20ms',
    ]);
    expect(logs.filter((line) => line.startsWith('SUCCESS'))).toEqual([]);

    siblingMode = 'healthy';
    await runWorkspaceRuntimeRefresh('ws-2');
    await runWorkspaceRuntimeRefresh('ws-2');

    expect(logs.filter((line) => line.startsWith('SUCCESS'))).toEqual([
      'SUCCESS Project goal runtime restored',
    ]);

    // Unregistering ws-2 while it is still stalled drops its remembered transition: a
    // relink restores the same id, so a stale "unavailable" would swallow the next real
    // failure and then log a recovery nobody saw.
    siblingMode = 'stalled';
    await runWorkspaceRuntimeRefresh('ws-2');
    expect(logs.filter((line) => line.startsWith('ERROR'))).toHaveLength(2);

    setCachedWorkspaces(['ws-1']);
    syncWorkspaceRuntimeStreams();
    setCachedWorkspaces(['ws-1', 'ws-2']);
    syncWorkspaceRuntimeStreams();
    await runWorkspaceRuntimeRefresh('ws-2');
    expect(logs.filter((line) => line.startsWith('ERROR'))).toHaveLength(3);

    clearWorkspaceRuntimeState('ws-2');
    await runWorkspaceRuntimeRefresh('ws-2');
    expect(logs.filter((line) => line.startsWith('ERROR'))).toHaveLength(4);

    siblingMode = 'healthy';
    await runWorkspaceRuntimeRefresh('ws-2');
    expect(logs.filter((line) => line.startsWith('SUCCESS'))).toHaveLength(2);
  });
});

describe('boot read resilience', () => {
  it('fails the settings boot read instead of hanging when the body stalls', async () => {
    const { elements, recorded, logs, loadSettings } = buildSettingsSandbox(() =>
      Promise.resolve(stalledBodyResponse()),
    );

    await Promise.race([
      loadSettings(),
      new Promise((_resolve, reject) => {
        setTimeout(
          () => reject(new Error('a stalled /api/settings body wedged the settings panel')),
          SETTLE_GUARD_MS,
        );
      }),
    ]);

    expect(recorded.urls).toEqual(['/api/settings']);
    const status = elements.get('settings-persistence-status');
    expect(status?.textContent).toBe('Persisted configuration load failed');
    expect(status?.dataset.state).toBe('load_failed');
    expect(
      logs.some(
        (line) =>
          line.startsWith('WARN Settings unavailable:')
          && line.includes('Response body timed out after'),
      ),
    ).toBe(true);
  });

  it('clears the goal loading pin when the goals body stalls', async () => {
    let stall = true;
    const transport = (): Promise<Response> =>
      Promise.resolve(
        stall
          ? stalledBodyResponse()
          : ({
              ok: true,
              status: 200,
              json: async (): Promise<Record<string, unknown>> => ({
                goals: [{ id: 'goal-1' }],
                preferredGoalId: 'goal-1',
              }),
            } as unknown as Response),
      );
    const { recorded, logs, workspaceGoals, loadingWorkspaceGoals, loadWorkspaceGoals } =
      buildGoalsSandbox(transport);

    await Promise.race([
      loadWorkspaceGoals('ws-1'),
      new Promise((_resolve, reject) => {
        setTimeout(
          () => reject(new Error('a stalled goals body pinned the project row')),
          SETTLE_GUARD_MS,
        );
      }),
    ]);

    expect(recorded.urls).toEqual(['/api/workspaces/ws-1/goals']);
    expect([...loadingWorkspaceGoals]).toEqual([]);
    expect(workspaceGoals.get('ws-1')?.error).toContain('Response body timed out after');
    expect(logs.some((line) => line.startsWith('ERROR Goal refresh failed for ws-1'))).toBe(true);

    stall = false;
    await loadWorkspaceGoals('ws-1');

    expect(workspaceGoals.get('ws-1')).toEqual({
      goals: [{ id: 'goal-1' }],
      preferredGoalId: 'goal-1',
      error: null,
    });
    expect([...loadingWorkspaceGoals]).toEqual([]);
  });

  it('bounds every inventory read so a stalled body cannot block the tables', async () => {
    let stall = true;
    const transport = (url: string): Promise<Response> =>
      Promise.resolve(
        stall
          ? stalledBodyResponse()
          : ({
              ok: true,
              status: 200,
              json: async (): Promise<Record<string, unknown>> => {
                if (url === '/api/servers') return { servers: [{ id: 'server-1' }] };
                if (url === '/api/skills') return { skills: [{ name: 'skill-1' }] };
                return {
                  mcpServers: { entries: [{ id: 'server-1' }] },
                  skills: { entries: [{ name: 'skill-1' }] },
                };
              },
            } as unknown as Response),
      );
    const { elements, recorded, logs, loadInventory } = buildInventorySandbox(transport);

    await Promise.race([
      loadInventory(),
      new Promise((_resolve, reject) => {
        setTimeout(
          () => reject(new Error('a stalled inventory body wedged the inventory tables')),
          SETTLE_GUARD_MS,
        );
      }),
    ]);

    expect(recorded.urls).toEqual([
      '/api/servers',
      '/api/skills',
      '/api/extensions/canonical',
    ]);
    expect(
      logs.some(
        (line) =>
          line.startsWith('ERROR Inventory refresh error:')
          && line.includes('Response body timed out after'),
      ),
    ).toBe(true);

    stall = false;
    await loadInventory();

    expect(recorded.urls).toHaveLength(6);
    expect(elements.get('stat-servers-count')?.textContent).toBe('1');
    expect(elements.get('stat-skills-count')?.textContent).toBe('1');
  });

  it('bounds the policy read and reports it in the table', async () => {
    const { elements, recorded, logs, read } = buildPanelReadSandbox(
      () => Promise.resolve(stalledBodyResponse()),
      'loadPolicies',
      ['policy-table-body', 'policies-detailed-table-body'],
    );

    await Promise.race([
      read(),
      new Promise((_resolve, reject) => {
        setTimeout(
          () => reject(new Error('a stalled /api/policies body wedged the policy table')),
          SETTLE_GUARD_MS,
        );
      }),
    ]);

    expect(recorded.urls).toEqual(['/api/policies']);
    expect(logs).toEqual([]);
    expect(elements.get('policy-table-body')?.children[0]?.children[0]?.textContent).toContain(
      'Failed to load policies: Response body timed out after',
    );
  });

  it('bounds the cleanup evaluation read and reports it in the table', async () => {
    const { elements, recorded, logs, read } = buildPanelReadSandbox(
      () => Promise.resolve(stalledBodyResponse()),
      'loadCleanupEvaluations',
      ['cleanup-evaluations-body'],
    );

    await Promise.race([
      read(),
      new Promise((_resolve, reject) => {
        setTimeout(
          () => reject(new Error('a stalled cleanup read wedged the cleanup table')),
          SETTLE_GUARD_MS,
        );
      }),
    ]);

    expect(recorded.urls).toEqual(['/api/workspaces/cleanup-evaluations']);
    expect(
      logs.some(
        (line) =>
          line.startsWith('WARN Cleanup evaluation refresh failed:')
          && line.includes('Response body timed out after'),
      ),
    ).toBe(true);
    expect(elements.get('cleanup-evaluations-body')?.children[0]?.children[0]?.textContent).toContain(
      'Failed to load cleanup evaluations: Response body timed out after',
    );
  });
});
