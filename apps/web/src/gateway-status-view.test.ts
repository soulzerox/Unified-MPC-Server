import { describe, expect, it } from 'vitest';
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
  let depth = 0;
  for (let index = script.indexOf('{', start); index < script.length; index += 1) {
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

function loadGatewayStatusForTest(fetchImpl: typeof fetch): {
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
    'fetch',
    'isBackendTransportError',
    'noteBackendUnavailable',
    `${extractFunction(script, 'renderGatewayUnavailable')}\n${extractFunction(script, 'loadGatewayStatus')}\nreturn loadGatewayStatus;`,
  );
  const loadGatewayStatus = factory(
    document,
    fetchImpl,
    (error: unknown) => error instanceof TypeError,
    () => {},
  ) as () => Promise<void>;
  return { elements, loadGatewayStatus };
}

describe('gateway status projection', () => {
  it('fails closed when a healthy gateway loses the control plane', async () => {
    let mode: 'healthy' | 'transport-failure' = 'healthy';
    const fetchImpl = async (): Promise<Response> => {
      if (mode === 'transport-failure') throw new TypeError('fetch failed');
      return {
        ok: true,
        json: async (): Promise<Record<string, string>> => ({
          state: 'BRIDGE_HEALTHY',
          tunnelUrl: 'https://tunnel.example',
          mcpUrl: 'https://mcp.example',
        }),
      } as unknown as Response;
    };
    const { elements, loadGatewayStatus } = loadGatewayStatusForTest(fetchImpl as typeof fetch);

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

  it('does not render a static success badge for the loopback origin', () => {
    const html = renderDashboardHtml();
    expect(html).toContain('LOOPBACK');
    expect(html).not.toContain('ORIGIN: OK');
  });
});
