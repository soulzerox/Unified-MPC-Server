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

  it('trims a page by bytes in one pass and leaves an in-budget page byte-identical', async () => {
    const content = 'alpha\r\nbeta\r\ngamma';
    const crlfServices: McpApplicationServices = {
      file: {
        async readFile(_actor, _workspaceId, request): Promise<ReturnType<typeof ok>> {
          return ok({
            path: request.path,
            content,
            startLine: 1,
            endLine: 3,
            encoding: 'utf8' as const,
            byteLength: Buffer.byteLength(content, 'utf8'),
          });
        },
      },
    };
    const engine = new FilePageEngine(crlfServices, actor);

    // No budget: the page is returned untouched, including its line endings.
    await expect(engine.readPage({ path: 'src/crlf.ts', pageSize: 5 })).resolves.toMatchObject({
      ok: true,
      value: { content, startLine: 1, endLine: 3, hasMore: false, byteLength: 18 },
    });

    // maxTextBytes 12: 'alpha' (5) + '\nbeta' (5) = 10, so 'gamma' (6 more) is dropped.
    const trimmed = await engine.readPage({ path: 'src/crlf.ts', pageSize: 5 }, {
      maxItems: 5,
      maxTextBytes: 12,
      maxStructuredBytes: 12,
      maxBinaryBytes: 12,
      maxBase64Bytes: 12,
    } satisfies ResultBudget);

    expect(trimmed).toMatchObject({
      ok: true,
      value: { content: 'alpha\nbeta', startLine: 1, endLine: 2, hasMore: true, byteLength: 10 },
    });
  });

  it('keeps a CRLF page inside the byte budget when only normalization makes it fit', async () => {
    const content = 'aa\r\nbb';
    const crlfServices: McpApplicationServices = {
      file: {
        async readFile(_actor, _workspaceId, request): Promise<ReturnType<typeof ok>> {
          return ok({ path: request.path, content, startLine: 1, endLine: 2, encoding: 'utf8' as const, byteLength: Buffer.byteLength(content, 'utf8') });
        },
      },
    };

    const result = await new FilePageEngine(crlfServices, actor).readPage({ path: 'src/crlf-budget.ts', pageSize: 5 }, {
      maxItems: 5,
      maxTextBytes: 5,
      maxStructuredBytes: 5,
      maxBinaryBytes: 5,
      maxBase64Bytes: 5,
    } satisfies ResultBudget);

    // 6 raw bytes exceed the 5-byte target, 5 LF-normalized bytes do not.
    expect(result).toMatchObject({ ok: true, value: { content: 'aa\nbb', endLine: 2, hasMore: false, byteLength: 5 } });
  });

  it('keeps a leading empty line inside the page instead of shifting the line count', async () => {
    const content = '\na\nb';
    const leadingEmptyServices: McpApplicationServices = {
      file: {
        async readFile(_actor, _workspaceId, request): Promise<ReturnType<typeof ok>> {
          return ok({ path: request.path, content, startLine: 1, endLine: 3, encoding: 'utf8' as const, byteLength: Buffer.byteLength(content, 'utf8') });
        },
      },
    };

    const result = await new FilePageEngine(leadingEmptyServices, actor).readPage({ path: 'src/leading-empty.ts', pageSize: 5 }, {
      maxItems: 5,
      maxTextBytes: 3,
      maxStructuredBytes: 3,
      maxBinaryBytes: 3,
      maxBase64Bytes: 3,
    } satisfies ResultBudget);

    // Line 1 is empty; dropping it (the previous byte pass did) would report
    // line 2 as `endLine: 1` and shift every continuation.
    expect(result).toMatchObject({ ok: true, value: { content: '\na', startLine: 1, endLine: 2, hasMore: true, byteLength: 2 } });
  });

  it('rejects an unknown continuation token without changing the source read contract', async () => {
    const result = await new FilePageEngine(services(), actor).continue('missing-token');

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
});
