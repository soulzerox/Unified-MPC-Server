import { describe, expect, it } from 'vitest';
import type { ResultBudget } from '@unified-mpc/domain';
import { ragTools } from './rag-tools.js';

const budget: ResultBudget = { maxItems: 2, maxTextBytes: 128, maxStructuredBytes: 128, maxBinaryBytes: 128, maxBase64Bytes: 128 };
const signal = new AbortController().signal;

const inputs: Readonly<Record<string, unknown>> = {
  rag_recall: { workspaceId: 'workspace-1', query: 'needle' },
  rag_remember: { workspaceId: 'workspace-1', content: 'note' },
  workspace_memory_record: { workspaceId: 'workspace-1', name: 'note', observations: ['value'] },
  rag_forget: { workspaceId: 'workspace-1', memoryId: 'memory-1' },
  rag_pre_edit_context: { workspaceId: 'workspace-1', filePath: 'src/index.ts' },
  rag_code_search: { workspaceId: 'workspace-1', query: 'needle' },
  rag_code_context: { workspaceId: 'workspace-1', filePath: 'src/index.ts', lineNumber: 1 },
  rag_code_blast_radius: { workspaceId: 'workspace-1', symbolName: 'run' },
  rag_code_index: { workspaceId: 'workspace-1' },
  rag_index_status: { workspaceId: 'workspace-1', jobId: 'job-1' },
};

describe('native RAG tool budgets', () => {
  it('passes signal and result budget to every native producer', async () => {
    const calls: Array<{ tool: string; signal: AbortSignal; budget?: ResultBudget }> = [];
    const tools = ragTools({
      ragRecall: async (_workspaceId: string, _query: string, _category: string | undefined, _limit: number | undefined, callSignal: AbortSignal, callBudget?: ResultBudget) => {
        calls.push({ tool: 'recall', signal: callSignal, budget: callBudget });
        return { ok: true, value: {} };
      },
      nativeRagCall: async (_workspaceId: string, tool: string, _args: Readonly<Record<string, unknown>>, callSignal: AbortSignal, callBudget?: ResultBudget) => {
        calls.push({ tool, signal: callSignal, budget: callBudget });
        return { ok: true, value: {} };
      },
      ragRemember: async (_workspaceId: string, _content: string, _category: string | undefined, callSignal: AbortSignal, callBudget?: ResultBudget) => {
        calls.push({ tool: 'remember', signal: callSignal, budget: callBudget });
        return { ok: true, value: {} };
      },
    } as never);

    for (const tool of tools) {
      const parsed = tool.parse(inputs[tool.name]);
      expect(parsed.ok, tool.name).toBe(true);
      await tool.execute(inputs[tool.name], signal, undefined, budget);
    }

    expect(calls).toHaveLength(tools.length);
    expect(calls.every((call) => call.signal === signal && call.budget === budget)).toBe(true);
  });
});
