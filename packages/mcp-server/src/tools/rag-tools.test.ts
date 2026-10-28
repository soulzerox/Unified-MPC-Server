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
  rag_adopt_legacy_index: {
    workspaceId: 'workspace-1',
    dryRun: true,
    legacyEmbeddingProfileFingerprint: 'embed-legacy',
    legacyChunkingFingerprint: 'chunk-legacy',
  },
  rag_code_index: { workspaceId: 'workspace-1' },
  rag_index_status: { workspaceId: 'workspace-1', jobId: 'job-1' },
  rag_cancel_index: { workspaceId: 'workspace-1', jobId: 'job-1' },
  rag_resolve_constraint: { workspaceId: 'workspace-1', turnId: 'event-1', resolution: 'condition retired' },
  rag_get_event: { workspaceId: 'workspace-1', turnId: 'event-1' },
  rag_memory_reconcile: { workspaceId: 'workspace-1', dryRun: true },
  rag_code_reconcile: { workspaceId: 'workspace-1', dryRun: true },
};

describe('legacy adoption tool', () => {
  it('defaults to dry-run, forwards explicit fingerprints, and never calls code_index', async () => {
    const calls: Array<{ tool: string; args: Readonly<Record<string, unknown>> }> = [];
    const tool = ragTools({
      nativeRagCall: async (_workspaceId: string, name: string, args: Readonly<Record<string, unknown>>) => {
        calls.push({ tool: name, args });
        return { ok: true, value: {} };
      },
    } as never).find((candidate) => candidate.name === 'rag_adopt_legacy_index');
    expect(tool).toBeDefined();

    await tool?.execute({
      workspaceId: 'workspace-1',
      legacyEmbeddingProfileFingerprint: 'embed-legacy',
      legacyChunkingFingerprint: 'chunk-legacy',
    }, signal);

    expect(calls).toEqual([{
      tool: 'adopt_legacy_index',
      args: {
        dry_run: true,
        legacy_embedding_profile_fingerprint: 'embed-legacy',
        legacy_chunking_fingerprint: 'chunk-legacy',
      },
    }]);
    expect(calls.some((call) => call.tool === 'code_index')).toBe(false);
  });
});

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

describe('native RAG code blast radius identity opt-in', () => {
  it('forwards includeHeuristic only when the caller asks for heuristic edges', async () => {
    const seen: Array<{ tool: string; args: Readonly<Record<string, unknown>> }> = [];
    const tools = ragTools({
      nativeRagCall: async (_workspaceId: string, tool: string, args: Readonly<Record<string, unknown>>) => {
        seen.push({ tool, args });
        return { ok: true, value: {} };
      },
    } as never);
    const tool = tools.find((candidate) => candidate.name === 'rag_code_blast_radius');
    if (tool === undefined) throw new Error('rag_code_blast_radius is not registered');
    const signal = new AbortController().signal;

    expect(tool.parse({ workspaceId: 'workspace-1', symbolName: 'run', includeHeuristic: true }).ok).toBe(true);
    await tool.execute(
      { workspaceId: 'workspace-1', symbolName: 'run', includeHeuristic: true },
      signal,
      undefined,
      undefined,
    );
    await tool.execute({ workspaceId: 'workspace-1', symbolName: 'run' }, signal, undefined, undefined);

    expect(seen.map((call) => call.tool)).toEqual(['code_blast_radius', 'code_blast_radius']);
    expect(seen[0].args).toEqual({ symbol_name: 'run', include_heuristic: true });
    expect(seen[1].args).toEqual({ symbol_name: 'run' });
  });
});

describe('native RAG constraint closure', () => {
  it('forwards a resolution with its audit fields and omits absent ones', async () => {
    const seen: Array<{ tool: string; args: Readonly<Record<string, unknown>> }> = [];
    const tools = ragTools({
      nativeRagCall: async (_workspaceId: string, tool: string, args: Readonly<Record<string, unknown>>) => {
        seen.push({ tool, args });
        return { ok: true, value: { status: 'resolved' } };
      },
    } as never);
    const tool = tools.find((candidate) => candidate.name === 'rag_resolve_constraint');
    if (tool === undefined) throw new Error('rag_resolve_constraint is not registered');
    const signal = new AbortController().signal;

    expect(tool.parse({ workspaceId: 'workspace-1', turnId: 'event-1', resolution: '   ' }).ok).toBe(false);
    expect(tool.parse({ workspaceId: 'workspace-1', turnId: 'event-1' }).ok).toBe(false);

    await tool.execute({
      workspaceId: 'workspace-1',
      turnId: 'event-1',
      resolution: 'condition retired',
      evidence: 'generation 30b4d9bbe316',
      resolvedBy: 'operator',
    }, signal, undefined, undefined);
    await tool.execute({
      workspaceId: 'workspace-1',
      turnId: 'event-1',
      resolution: 'condition retired',
    }, signal, undefined, undefined);

    expect(seen.map((call) => call.tool)).toEqual(['resolve_event', 'resolve_event']);
    expect(seen[0].args).toEqual({
      turn_id: 'event-1',
      resolution: 'condition retired',
      evidence: 'generation 30b4d9bbe316',
      resolved_by: 'operator',
    });
    expect(seen[1].args).toEqual({ turn_id: 'event-1', resolution: 'condition retired' });
  });

  it('reads a closure trail by id through get_event', async () => {
    const seen: Array<{ tool: string; args: Readonly<Record<string, unknown>> }> = [];
    const tools = ragTools({
      nativeRagCall: async (_workspaceId: string, tool: string, args: Readonly<Record<string, unknown>>) => {
        seen.push({ tool, args });
        return { ok: true, value: { status: 'ok', resolved_by: 'operator' } };
      },
    } as never);
    const tool = tools.find((candidate) => candidate.name === 'rag_get_event');
    if (tool === undefined) throw new Error('rag_get_event is not registered');
    const signal = new AbortController().signal;

    await tool.execute({ workspaceId: 'workspace-1', turnId: 'event-1' }, signal, undefined, undefined);

    expect(seen).toEqual([{ tool: 'get_event', args: { turn_id: 'event-1' } }]);
  });
});

describe('native RAG vector and index repair', () => {
  it('defaults memory reconcile to dry-run and forwards an explicit replay', async () => {
    const seen: Array<{ tool: string; args: Readonly<Record<string, unknown>> }> = [];
    const tools = ragTools({
      nativeRagCall: async (_workspaceId: string, tool: string, args: Readonly<Record<string, unknown>>) => {
        seen.push({ tool, args });
        return { ok: true, value: { status: 'ok', pending: 0 } };
      },
    } as never);
    const tool = tools.find((candidate) => candidate.name === 'rag_memory_reconcile');
    if (tool === undefined) throw new Error('rag_memory_reconcile is not registered');
    const signal = new AbortController().signal;

    const defaults = tool.parse({ workspaceId: 'workspace-1' });
    expect(defaults.ok).toBe(true);
    await tool.execute({ workspaceId: 'workspace-1' }, signal, undefined, undefined);

    await tool.execute({ workspaceId: 'workspace-1', dryRun: false, limit: 25 }, signal, undefined, undefined);

    expect(seen.map((call) => call.tool)).toEqual(['memory_reconcile', 'memory_reconcile']);
    expect(seen[0].args).toEqual({ dry_run: true });
    expect(seen[1].args).toEqual({ dry_run: false, limit: 25 });
  });

  it('defaults code reconcile to dry-run and forwards an explicit repair', async () => {
    const seen: Array<{ tool: string; args: Readonly<Record<string, unknown>> }> = [];
    const tools = ragTools({
      nativeRagCall: async (_workspaceId: string, tool: string, args: Readonly<Record<string, unknown>>) => {
        seen.push({ tool, args });
        return { ok: true, value: { status: 'ok' } };
      },
    } as never);
    const tool = tools.find((candidate) => candidate.name === 'rag_code_reconcile');
    if (tool === undefined) throw new Error('rag_code_reconcile is not registered');
    const signal = new AbortController().signal;

    await tool.execute({ workspaceId: 'workspace-1' }, signal, undefined, undefined);
    await tool.execute({ workspaceId: 'workspace-1', dryRun: false }, signal, undefined, undefined);
    expect(tool.parse({ workspaceId: 'workspace-1', limit: 5 }).ok).toBe(false);

    expect(seen.map((call) => call.tool)).toEqual(['code_reconcile', 'code_reconcile']);
    expect(seen[0].args).toEqual({ dry_run: true });
    expect(seen[1].args).toEqual({ dry_run: false });
  });
});
