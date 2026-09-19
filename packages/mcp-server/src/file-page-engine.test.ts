import { describe, expect, it } from 'vitest';
import { ok, type ResultBudget } from '@unified-mpc/domain';
import type { McpApplicationServices } from './tools/tool-types.js';
import { FilePageEngine, type FilePageRequest } from './file-page-engine.js';

const actor = { clientId: 'page-test', clientName: 'page-test' };

function services(): McpApplicationServices {
  return {
    file: {
      async readFile(_actor, _workspaceId, request): Promise<ReturnType<typeof ok>> {
        const lines = ['one', 'two', 'three', 'four', 'five'];
        const start = request.startLine ?? 1;
        const end = Math.min(request.endLine ?? lines.length, lines.length);
        return ok({
          path: request.path,
          content: lines.slice(start - 1, end).join('\n'),
          startLine: start,
          endLine: end,
          encoding: 'utf8' as const,
          byteLength: lines.slice(start - 1, end).join('\n').length,
        });
      },
    },
  };
}

describe('file page engine', () => {
  it('returns deterministic chunks and resumes from the next line', async () => {
    const engine = new FilePageEngine(services(), actor);
    const request: FilePageRequest = { workspaceId: 'workspace-1', path: 'src/file.ts', pageSize: 2 };
    const first = await engine.readPage(request);

    expect(first.ok).toBe(true);
    if (!first.ok || first.value.continuationToken === undefined) return;
    expect(first.value).toMatchObject({ path: 'src/file.ts', startLine: 1, endLine: 2, content: 'one\ntwo', hasMore: true });

    const second = await engine.continue(first.value.continuationToken, 2);
    expect(second).toMatchObject({ ok: true, value: { startLine: 3, endLine: 4, content: 'three\nfour', hasMore: true } });
    if (!second.ok || second.value.continuationToken === undefined) return;

    const last = await engine.continue(second.value.continuationToken, 2);
    expect(last).toEqual({
      ok: true,
      value: {
        path: 'src/file.ts',
        startLine: 5,
        endLine: 5,
        content: 'five',
        encoding: 'utf8',
        byteLength: 4,
        hasMore: false,
      },
    });
  });

  it('expires and caps abandoned continuation tokens', async () => {
    let now = 0;
    const engine = new FilePageEngine(services(), actor, {
      continuationTtlMs: 100,
      maxContinuations: 1,
      now: (): number => now,
    });

    const first = await engine.readPage({ workspaceId: 'workspace-1', path: 'src/one.ts', pageSize: 1 });
    const second = await engine.readPage({ workspaceId: 'workspace-1', path: 'src/two.ts', pageSize: 1 });
    expect(first.ok && first.value.continuationToken).toEqual(expect.any(String));
    expect(second.ok && second.value.continuationToken).toEqual(expect.any(String));
    if (!first.ok || !second.ok || first.value.continuationToken === undefined || second.value.continuationToken === undefined) return;

    await expect(engine.continue(first.value.continuationToken)).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    now = 101;
    await expect(engine.continue(second.value.continuationToken)).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('bounds page size and response bytes before reading', async () => {
    const engine = new FilePageEngine(services(), actor);
    const result = await engine.readPage({ workspaceId: 'workspace-1', path: 'src/file.ts', pageSize: 5 }, {
      maxItems: 2,
      maxTextBytes: 4,
      maxStructuredBytes: 4,
      maxBinaryBytes: 4,
      maxBase64Bytes: 4,
    } satisfies ResultBudget);

    expect(result).toMatchObject({ ok: true, value: { endLine: 1, content: 'one' } });
  });

  it('rejects an unknown continuation token without changing the source read contract', async () => {
    const result = await new FilePageEngine(services(), actor).continue('missing-token');

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
});
