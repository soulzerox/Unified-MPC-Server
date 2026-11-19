import { describe, expect, it } from 'vitest';
import { getClientScriptJs } from './ui/client-script.js';

type FakeNode = {
  textContent: string;
  className: string;
  children: FakeNode[];
  appendChild(child: FakeNode): void;
};

function fakeNode(): FakeNode {
  return {
    textContent: '',
    className: '',
    children: [],
    appendChild(child: FakeNode): void {
      this.children.push(child);
    },
  };
}

function extractFunction(script: string, name: string): string {
  const marker = `function ${name}(`;
  const start = script.indexOf(marker);
  if (start < 0) throw new Error(`function ${name} is missing from the client script`);
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

type Projection = Record<string, unknown>;

function render(projection: Projection | null): FakeNode | null {
  const document = { createElement: (): FakeNode => fakeNode() };
  const factory = new Function(
    'document',
    `${extractFunction(getClientScriptJs(), 'renderWorkflowGatePosture')}\nreturn renderWorkflowGatePosture;`,
  );
  return (factory(document) as (value: Projection | null) => FakeNode | null)(projection);
}

function text(node: FakeNode | null): string {
  if (node === null) return '';
  return [node.textContent, ...node.children.map((child) => text(child))].join(' | ');
}

describe('renderWorkflowGatePosture', () => {
  it('renders nothing when the server could not produce a projection', () => {
    expect(render(null)).toBeNull();
  });

  it('names the blocker and the action that clears it', () => {
    const node = render({
      phase: 'mutate',
      mode: 'require_preparation',
      evaluated: true,
      blocked: true,
      blockers: [{ code: 'preparation_missing', detail: 'src/app.ts', clearedBy: 'Run prepare_code_change' }],
    });

    expect(text(node)).toContain('requires evidence for a path-named write');
    expect(text(node)).toContain('preparation_missing (src/app.ts)');
    expect(text(node)).toContain('Run prepare_code_change');
  });

  it('shows the note and the per-session caveat rather than a verdict about the reader', () => {
    const node = render({
      phase: 'mutate',
      mode: 'auto_prepare',
      evaluated: false,
      blocked: false,
      blockers: [],
      note: 'This workspace prepares evidence on demand',
    });

    expect(text(node)).toContain('nothing required for a path-named write');
    expect(text(node)).toContain('prepares evidence on demand');
    expect(text(node)).toContain('per session');
  });
});
