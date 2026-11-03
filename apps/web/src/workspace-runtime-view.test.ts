import { describe, expect, it } from 'vitest';
import { getClientScriptJs } from './ui/client-script.js';

type FakeNode = {
  textContent: string;
  className: string;
  title: string;
  colSpan: number;
  type: string;
  disabled: boolean;
  style: Record<string, string>;
  attrs: Record<string, string>;
  children: FakeNode[];
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | undefined;
  appendChild(child: FakeNode): void;
  replaceChildren(...nodes: FakeNode[]): void;
  addEventListener(): void;
};

function fakeNode(): FakeNode {
  return {
    textContent: '',
    className: '',
    title: '',
    colSpan: 0,
    type: '',
    disabled: false,
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
    replaceChildren(...nodes: FakeNode[]): void {
      this.children = nodes;
    },
    addEventListener(): void {},
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

type RuntimeRecord = { projection: { goalId: string; runtimeState: string } };
type RuntimeEntry = { snapshots: RuntimeRecord[] } | { error: string };

/**
 * Builds the shipped Projects table around a fake DOM, so a test can read what a row
 * shows for selection (In Scope / Default) and runtime (badges) independently.
 */
function buildProjectTableSandbox(): {
  setWorkspaces: (workspaces: Array<Record<string, unknown>>) => void;
  setSelection: (selection: { primaryWorkspaceId: string; activeWorkspaceIds: string[] }) => void;
  setRuntime: (workspaceId: string, entry: RuntimeEntry) => void;
  renderWorkspaces: () => void;
  projectRows: () => FakeNode[];
  cellText: (rowIndex: number, cellIndex: number) => string;
} {
  const script = getClientScriptJs();
  const body = fakeNode();
  const document = {
    getElementById: (id: string): FakeNode | null => (id === 'projects-table-body' ? body : null),
    createElement: (): FakeNode => fakeNode(),
  };
  const factory = new Function(
    'document',
    `let cachedWorkspaces = [];\n`
      + `let workspaceSelection = null;\n`
      + `const expandedWorkspaceGoals = new Set();\n`
      + `const workspaceRuntime = new Map();\n`
      + `const workspaceRuntimeTargets = new Map();\n`
      + `${extractFunction(script, 'addCell')}\n`
      + `${extractFunction(script, 'emptyRow')}\n`
      + `${extractFunction(script, 'runtimeBadgeClass')}\n`
      + `${extractFunction(script, 'renderWorkspaceRuntimeCell')}\n`
      + `${extractFunction(script, 'renderWorkspaces')}\n`
      + `return {\n`
      + `  renderWorkspaces,\n`
      + `  setWorkspaces(value) { cachedWorkspaces = value; },\n`
      + `  setSelection(value) { workspaceSelection = value; },\n`
      + `  setRuntime(id, entry) { workspaceRuntime.set(id, entry); },\n`
      + `};`,
  );
  const built = factory(document) as {
    renderWorkspaces: () => void;
    setWorkspaces: (workspaces: Array<Record<string, unknown>>) => void;
    setSelection: (selection: { primaryWorkspaceId: string; activeWorkspaceIds: string[] }) => void;
    setRuntime: (workspaceId: string, entry: RuntimeEntry) => void;
  };
  return {
    ...built,
    projectRows: (): FakeNode[] => body.children,
    cellText: (rowIndex: number, cellIndex: number): string => {
      const cell = body.children[rowIndex]?.children[cellIndex];
      if (!cell) return '';
      const flatten = (node: FakeNode): string =>
        node.children.length === 0 ? node.textContent : node.children.map(flatten).join(' ');
      return flatten(cell).trim();
    },
  };
}

function runtimeSnapshot(goalId: string, runtimeState: string): RuntimeRecord {
  return { projection: { goalId, runtimeState } };
}

function twoProjects(): Array<Record<string, unknown>> {
  return [
    { id: 'ws-1', displayName: 'Alpha', rootPath: '/src/alpha', openGoalCount: 0 },
    { id: 'ws-2', displayName: 'Beta', rootPath: '/src/beta', openGoalCount: 0 },
  ];
}

describe('Projects table selection vs runtime', () => {
  it('renders two projects running at the same time even though only one is in scope', () => {
    const table = buildProjectTableSandbox();
    table.setWorkspaces(twoProjects());
    table.setSelection({ primaryWorkspaceId: 'ws-1', activeWorkspaceIds: ['ws-1'] });
    table.setRuntime('ws-1', { snapshots: [runtimeSnapshot('goal-1', 'running')] });
    table.setRuntime('ws-2', { snapshots: [runtimeSnapshot('goal-2', 'running')] });

    table.renderWorkspaces();

    expect(table.projectRows()).toHaveLength(2);
    expect(table.cellText(0, 2)).toBe('In Scope');
    expect(table.cellText(1, 2)).toBe('Out of Scope');
    expect(table.cellText(0, 4)).toBe('running');
    expect(table.cellText(1, 4)).toBe('running');
  });

  it('never labels a selection-only project as running', () => {
    const table = buildProjectTableSandbox();
    table.setWorkspaces(twoProjects());
    table.setSelection({ primaryWorkspaceId: 'ws-1', activeWorkspaceIds: ['ws-1', 'ws-2'] });
    table.setRuntime('ws-1', { snapshots: [runtimeSnapshot('goal-1', 'idle')] });
    table.setRuntime('ws-2', { snapshots: [runtimeSnapshot('goal-2', 'idle')] });

    table.renderWorkspaces();

    expect(table.cellText(0, 2)).toBe('In Scope');
    expect(table.cellText(1, 2)).toBe('In Scope');
    expect(table.cellText(0, 4)).toBe('idle');
    expect(table.cellText(1, 4)).toBe('idle');

    const withoutRuntime = buildProjectTableSandbox();
    withoutRuntime.setWorkspaces(twoProjects());
    withoutRuntime.setSelection({ primaryWorkspaceId: 'ws-1', activeWorkspaceIds: ['ws-1', 'ws-2'] });
    withoutRuntime.renderWorkspaces();
    expect(withoutRuntime.cellText(0, 4)).toBe('Loading runtime');
    expect(withoutRuntime.cellText(1, 4)).toBe('Loading runtime');
  });

  it('keeps runtime badges unchanged when the default project changes', () => {
    const table = buildProjectTableSandbox();
    table.setWorkspaces(twoProjects());
    table.setSelection({ primaryWorkspaceId: 'ws-1', activeWorkspaceIds: ['ws-1', 'ws-2'] });
    table.setRuntime('ws-1', { snapshots: [runtimeSnapshot('goal-1', 'running')] });
    table.setRuntime('ws-2', { snapshots: [runtimeSnapshot('goal-2', 'idle')] });
    table.renderWorkspaces();

    expect(table.cellText(0, 3)).toBe('Default');
    expect(table.cellText(1, 3)).toBe('—');
    const before = [table.cellText(0, 4), table.cellText(1, 4)];
    expect(before).toEqual(['running', 'idle']);

    table.setSelection({ primaryWorkspaceId: 'ws-2', activeWorkspaceIds: ['ws-1', 'ws-2'] });
    table.renderWorkspaces();

    expect(table.cellText(0, 3)).toBe('—');
    expect(table.cellText(1, 3)).toBe('Default');
    expect([table.cellText(0, 4), table.cellText(1, 4)]).toEqual(before);
  });
});
