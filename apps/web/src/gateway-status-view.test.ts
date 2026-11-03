import { describe, expect, it, vi } from 'vitest';
import { renderDashboardHtml } from './dashboard-html.js';
import { getClientScriptJs } from './ui/client-script.js';

type FakeElement = {
  textContent: string;
  className: string;
  disabled: boolean;
  title: string;
  style: Record<string, string>;
  attrs: Record<string, string>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | undefined;
};

type StatusFetch = (url: string) => Promise<Response>;

function fakeElement(): FakeElement {
  return {
    textContent: '',
    className: '',
    disabled: false,
    title: '',
    style: {},
    attrs: {},
    setAttribute(name: string, value: string): void {
      this.attrs[name] = value;
    },
    getAttribute(name: string): string | undefined {
      return this.attrs[name];
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

const elementIds = [
  'stat-bridge-state',
  'bridge-state',
  'tunnel-url',
  'chatgpt-view-tunnel-url',
  'chatgpt-view-tunnel-badge',
  'step-stopped',
  'step-initializing',
  'step-healthy',
  'step-connected',
  'canvas-gateway-dot',
  'connect-btn',
  'chatgpt-view-connect-btn',
];

function healthyResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async (): Promise<Record<string, string>> => ({
      state: 'BRIDGE_HEALTHY',
      tunnelUrl: 'https://tunnel.example',
      mcpUrl: 'https://mcp.example',
    }),
  } as unknown as Response;
}

function failedResponse(): Response {
  return {
    ok: false,
    status: 500,
    json: async (): Promise<Record<string, string>> => ({}),
  } as unknown as Response;
}

function malformedResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async (): Promise<Record<string, string>> => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
  } as unknown as Response;
}

function loadGatewayStatusForTest(
  fetchImpl: StatusFetch,
  readJsonWithTimeout: (res: Response) => Promise<Record<string, unknown>>,
): {
  elements: Map<string, FakeElement>;
  loadGatewayStatus: () => Promise<void>;
} {
  const script = getClientScriptJs();
  const elements = new Map(elementIds.map((id) => [id, fakeElement()]));
  const document = {
    getElementById: (id: string): FakeElement | null => elements.get(id) ?? null,
  };
  const factory = new Function(
    'document',
    'fetchWithTimeout',
    'readJsonWithTimeout',
    'isBackendTransportError',
    'noteBackendUnavailable',
    `let gatewayStatusSeq = 0;\nlet gatewayStatusAppliedSeq = 0;\n${extractFunction(script, 'renderGatewayUnavailable')}\n${extractFunction(script, 'loadGatewayStatus')}\nreturn loadGatewayStatus;`,
  );
  const loadGatewayStatus = factory(
    document,
    fetchImpl,
    readJsonWithTimeout,
    () => true,
    () => {},
  ) as () => Promise<void>;
  return { elements, loadGatewayStatus };
}

/**
 * The shipped body reader with a short budget, so a stalled body is observable in a test.
 */
function shortBodyReader(timeoutMs = 20): (res: Response) => Promise<Record<string, unknown>> {
  const factory = new Function(
    `const REQUEST_TIMEOUT_MS = 8000;\n`
      + `const fetchControllers = new WeakMap();\n`
      + `${extractFunction(getClientScriptJs(), 'readJsonWithTimeout')}\nreturn readJsonWithTimeout;`,
  );
  const realBody = factory() as (
    res: Response,
    timeoutMs: number,
  ) => Promise<Record<string, unknown>>;
  return (res: Response): Promise<Record<string, unknown>> => realBody(res, timeoutMs);
}

describe('gateway status projection', () => {
  it('fails closed when a healthy gateway loses the control plane', async () => {
    let mode: 'healthy' | 'transport-failure' = 'healthy';
    const fetchImpl = async (): Promise<Response> => {
      if (mode === 'transport-failure') throw new TypeError('fetch failed');
      return healthyResponse();
    };
    const { elements, loadGatewayStatus } = loadGatewayStatusForTest(fetchImpl, shortBodyReader());

    await loadGatewayStatus();
    expect(elements.get('canvas-gateway-dot')?.attrs.fill).toBe('#10B981');
    expect(elements.get('connect-btn')?.disabled).toBe(false);

    mode = 'transport-failure';
    await loadGatewayStatus();
    expect(elements.get('canvas-gateway-dot')?.attrs.fill).toBe('#EF4444');
    expect(elements.get('connect-btn')?.disabled).toBe(true);
    expect(elements.get('chatgpt-view-connect-btn')?.disabled).toBe(true);
    expect(elements.get('connect-btn')?.title).toBe('Gateway status unavailable');
    expect(elements.get('stat-bridge-state')?.textContent).toBe('UNKNOWN');
    expect(elements.get('bridge-state')?.textContent).toBe('UNKNOWN');
    expect(elements.get('chatgpt-view-tunnel-badge')?.textContent).toBe('Status Unknown');
  });

  it('fails closed on HTTP errors and malformed payloads, then recovers', async () => {
    let mode: 'healthy' | 'http-error' | 'bad-json' = 'healthy';
    const fetchImpl = async (): Promise<Response> => {
      if (mode === 'http-error') return failedResponse();
      if (mode === 'bad-json') return malformedResponse();
      return healthyResponse();
    };
    const { elements, loadGatewayStatus } = loadGatewayStatusForTest(fetchImpl, shortBodyReader());

    await loadGatewayStatus();
    expect(elements.get('canvas-gateway-dot')?.attrs.fill).toBe('#10B981');

    mode = 'http-error';
    await loadGatewayStatus();
    expect(elements.get('canvas-gateway-dot')?.attrs.fill).toBe('#EF4444');
    expect(elements.get('connect-btn')?.disabled).toBe(true);
    expect(elements.get('stat-bridge-state')?.textContent).toBe('UNKNOWN');

    mode = 'healthy';
    await loadGatewayStatus();
    expect(elements.get('canvas-gateway-dot')?.attrs.fill).toBe('#10B981');
    expect(elements.get('connect-btn')?.disabled).toBe(false);
    expect(elements.get('connect-btn')?.title).toBe('Ready to connect');
    expect(elements.get('stat-bridge-state')?.textContent).toBe('BRIDGE_HEALTHY');
    expect(elements.get('chatgpt-view-tunnel-badge')?.textContent).toBe('Active Tunnel');

    mode = 'bad-json';
    await loadGatewayStatus();
    expect(elements.get('canvas-gateway-dot')?.attrs.fill).toBe('#EF4444');
    expect(elements.get('connect-btn')?.disabled).toBe(true);
  });

  it('fails closed when a 200 body cannot be projected', async () => {
    let mode: 'healthy' | 'unprojectable' = 'healthy';
    const fetchImpl = async (): Promise<Response> => {
      if (mode === 'unprojectable') {
        return {
          ok: true,
          status: 200,
          json: async (): Promise<unknown> => null,
        } as unknown as Response;
      }
      return healthyResponse();
    };
    const { elements, loadGatewayStatus } = loadGatewayStatusForTest(fetchImpl, shortBodyReader());

    await loadGatewayStatus();
    expect(elements.get('canvas-gateway-dot')?.attrs.fill).toBe('#10B981');
    expect(elements.get('connect-btn')?.disabled).toBe(false);

    mode = 'unprojectable';
    await loadGatewayStatus();
    expect(elements.get('canvas-gateway-dot')?.attrs.fill).toBe('#EF4444');
    expect(elements.get('connect-btn')?.disabled).toBe(true);
    expect(elements.get('stat-bridge-state')?.textContent).toBe('UNKNOWN');

    mode = 'healthy';
    await loadGatewayStatus();
    expect(elements.get('canvas-gateway-dot')?.attrs.fill).toBe('#10B981');
    expect(elements.get('connect-btn')?.disabled).toBe(false);
  });

  it('ignores an older response that a newer applied response superseded', async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    let calls = 0;
    const fetchImpl = (): Promise<Response> => {
      calls += 1;
      if (calls === 1) {
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(healthyResponse());
    };
    const { elements, loadGatewayStatus } = loadGatewayStatusForTest(fetchImpl, shortBodyReader());

    const first = loadGatewayStatus();
    await loadGatewayStatus();
    expect(elements.get('canvas-gateway-dot')?.attrs.fill).toBe('#10B981');

    resolveFirst?.(failedResponse());
    await first;
    expect(elements.get('canvas-gateway-dot')?.attrs.fill).toBe('#10B981');
    expect(elements.get('connect-btn')?.disabled).toBe(false);
    expect(elements.get('stat-bridge-state')?.textContent).toBe('BRIDGE_HEALTHY');
  });

  it('ignores an older success that a newer failure superseded', async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    let calls = 0;
    const fetchImpl = (): Promise<Response> => {
      calls += 1;
      if (calls === 1) {
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(failedResponse());
    };
    const { elements, loadGatewayStatus } = loadGatewayStatusForTest(fetchImpl, shortBodyReader());

    const first = loadGatewayStatus();
    await loadGatewayStatus();
    expect(elements.get('canvas-gateway-dot')?.attrs.fill).toBe('#EF4444');
    expect(elements.get('connect-btn')?.disabled).toBe(true);

    resolveFirst?.(healthyResponse());
    await first;
    expect(elements.get('canvas-gateway-dot')?.attrs.fill).toBe('#EF4444');
    expect(elements.get('connect-btn')?.disabled).toBe(true);
    expect(elements.get('stat-bridge-state')?.textContent).toBe('UNKNOWN');
  });

  it('fails closed when a request times out with no newer applied response', async () => {
    const calls: string[] = [];
    const timeoutError = Object.assign(new Error('Request timed out after 8000ms'), {
      code: 'request_timeout',
    });
    const fetchImpl = async (url: string): Promise<Response> => {
      calls.push(url);
      throw timeoutError;
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { elements, loadGatewayStatus } = loadGatewayStatusForTest(fetchImpl, shortBodyReader());

      await loadGatewayStatus();
      expect(calls).toEqual(['/api/chatgpt-gateway/status']);
      expect(elements.get('canvas-gateway-dot')?.attrs.fill).toBe('#EF4444');
      expect(elements.get('connect-btn')?.disabled).toBe(true);
      expect(elements.get('connect-btn')?.title).toBe('Gateway status unavailable');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('fails closed when an older request times out while a newer one is still pending', async () => {
    let rejectOlder: ((error: Error) => void) | undefined;
    let resolveNewer: ((response: Response) => void) | undefined;
    let calls = 0;
    const timeoutError = Object.assign(new Error('Request timed out after 8000ms'), {
      code: 'request_timeout',
    });
    const fetchImpl = (): Promise<Response> => {
      calls += 1;
      if (calls === 1) return Promise.resolve(healthyResponse());
      if (calls === 2) {
        return new Promise<Response>((_resolve, reject) => {
          rejectOlder = reject;
        });
      }
      return new Promise<Response>((resolve) => {
        resolveNewer = resolve;
      });
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { elements, loadGatewayStatus } = loadGatewayStatusForTest(fetchImpl, shortBodyReader());

      await loadGatewayStatus();
      expect(elements.get('canvas-gateway-dot')?.attrs.fill).toBe('#10B981');

      const older = loadGatewayStatus();
      const newer = loadGatewayStatus();

      rejectOlder?.(timeoutError);
      await older;
      expect(calls).toBe(3);
      expect(elements.get('canvas-gateway-dot')?.attrs.fill).toBe('#EF4444');
      expect(elements.get('connect-btn')?.disabled).toBe(true);
      expect(elements.get('connect-btn')?.title).toBe('Gateway status unavailable');
      expect(elements.get('stat-bridge-state')?.textContent).toBe('UNKNOWN');

      resolveNewer?.(healthyResponse());
      await newer;
      expect(elements.get('canvas-gateway-dot')?.attrs.fill).toBe('#10B981');
      expect(elements.get('connect-btn')?.disabled).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('aborts a hung request through the real timeout helper', async () => {
    const script = getClientScriptJs();
    const factory = new Function(
      'fetch',
      `const REQUEST_TIMEOUT_MS = 8000;\n`
        + `const fetchControllers = new WeakMap();\n`
        + `${extractFunction(script, 'fetchWithTimeout')}\nreturn fetchWithTimeout;`,
    );
    const hangingFetch = (_url: string, init: RequestInit = {}): Promise<Response> =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    const fetchWithTimeout = factory(hangingFetch) as (
      url: string,
      init: RequestInit,
      timeoutMs: number,
    ) => Promise<Response>;

    await expect(fetchWithTimeout('/api/chatgpt-gateway/status', {}, 20)).rejects.toMatchObject({
      code: 'request_timeout',
    });
  });

  it('fails closed when a gateway response body stalls mid-stream', async () => {
    let stallBody = false;
    const fetchImpl = async (): Promise<Response> => {
      if (stallBody) {
        return {
          ok: true,
          status: 200,
          json: (): Promise<Record<string, string>> => new Promise<Record<string, string>>(() => {}),
        } as unknown as Response;
      }
      return healthyResponse();
    };
    const { elements, loadGatewayStatus } = loadGatewayStatusForTest(fetchImpl, shortBodyReader());

    await loadGatewayStatus();
    expect(elements.get('canvas-gateway-dot')?.attrs.fill).toBe('#10B981');
    expect(elements.get('connect-btn')?.disabled).toBe(false);

    stallBody = true;
    await Promise.race([
      loadGatewayStatus(),
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('a stalled gateway body left the surface healthy')), 2000);
      }),
    ]);

    expect(elements.get('canvas-gateway-dot')?.attrs.fill).toBe('#EF4444');
    expect(elements.get('connect-btn')?.disabled).toBe(true);
    expect(elements.get('connect-btn')?.title).toBe('Gateway status unavailable');

    stallBody = false;
    await loadGatewayStatus();
    expect(elements.get('canvas-gateway-dot')?.attrs.fill).toBe('#10B981');
    expect(elements.get('connect-btn')?.disabled).toBe(false);
  });

  it('does not render a static success badge for the loopback origin', () => {
    const html = renderDashboardHtml();
    expect(html).toContain('LOOPBACK');
    expect(html).not.toContain('ORIGIN: OK');
  });
});
