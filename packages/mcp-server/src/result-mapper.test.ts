import { describe, expect, it } from 'vitest';
import { mapError, mapResult } from './result-mapper.js';

describe('mapResult image payloads', () => {
  it('includes MCP image content for base64 image reads', () => {
    const response = mapResult({
      ok: true as const,
      value: {
        path: 'pixel.png',
        content: 'iVBORw0KGgo=',
        encoding: 'base64',
        mimeType: 'image/png',
        startLine: 1,
        endLine: 1,
      },
    });

    expect(response.content[0]).toEqual({ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' });
  });

  it('includes MCP image content for native vision and Set-of-Marks payloads', () => {
    const direct = mapResult({
      ok: true as const,
      value: { format: 'png', mime_type: 'image/png', data_base64: 'native-png', width: 10, height: 10 },
    });
    const annotated = mapResult({
      ok: true as const,
      value: { observationId: 'obs-1', image: { format: 'png', mime_type: 'image/png', data_base64: 'marked-png', width: 10, height: 10 } },
    });

    expect(direct.content[0]).toEqual({ type: 'image', data: 'native-png', mimeType: 'image/png' });
    expect(annotated.content[0]).toEqual({ type: 'image', data: 'marked-png', mimeType: 'image/png' });
  });

  it('replaces oversized successful results with a compact protocol-safe budget envelope', () => {
    const truncations: unknown[] = [];
    const response = mapResult({
      ok: true as const,
      value: { payload: 'x'.repeat(2_000_000) },
    }, {
      maxBytes: 1_024,
      toolName: 'mcp_call',
      onTruncated: (event) => truncations.push(event),
    });

    expect(response.structuredContent).toBeUndefined();
    expect(response.content).toHaveLength(1);
    const envelope = JSON.parse(response.content[0]?.type === 'text' ? response.content[0].text : '{}') as Record<string, unknown>;
    expect(envelope).toMatchObject({
      truncated: true,
      toolName: 'mcp_call',
      maxBytes: 1_024,
      reason: 'tool_result_exceeds_output_budget',
    });
    expect(Number(envelope.originalBytes)).toBeGreaterThan(1_024);
    expect(String(envelope.hint)).toContain('narrower');
    expect(response.content[0]?.type === 'text' ? response.content[0].text.length : Number.POSITIVE_INFINITY).toBeLessThan(1_024);
    expect(truncations).toEqual([expect.objectContaining({ toolName: 'mcp_call', maxBytes: 1_024 })]);
  });

  it('enforces explicit text, structured, and image budgets without returning oversized content', () => {
    const text = mapResult({ ok: true as const, value: 'x'.repeat(2_000) }, {
      budget: { maxTextBytes: 128 },
    });
    const structured = mapResult({ ok: true as const, value: { payload: 'x'.repeat(2_000) } }, {
      budget: { maxTextBytes: 4_096, maxStructuredBytes: 128 },
    });
    const image = mapResult({ ok: true as const, value: {
      content: 'x'.repeat(2_000), encoding: 'base64', mimeType: 'image/png',
    } }, {
      budget: { maxTextBytes: 4_096, maxBinaryBytes: 128, maxBase64Bytes: 128 },
    });

    expect(JSON.parse(text.content[0]?.type === 'text' ? text.content[0].text : '{}')).toMatchObject({ truncated: true, limitType: 'text' });
    expect(structured.structuredContent).toBeUndefined();
    expect(JSON.parse(structured.content[0]?.type === 'text' ? structured.content[0].text : '{}')).toMatchObject({ truncated: true, limitType: 'structured' });
    expect(image.content).toHaveLength(1);
    expect(JSON.parse(image.content[0]?.type === 'text' ? image.content[0].text : '{}')).toMatchObject({ truncated: true, limitType: 'binary' });
  });

  it('rejects oversized non-image base64 payloads before text serialization', () => {
    const response = mapResult({ ok: true as const, value: {
      content: 'x'.repeat(2_000), encoding: 'base64', mimeType: 'application/pdf',
    } }, { budget: { maxBinaryBytes: 128, maxBase64Bytes: 256 } });

    const envelope = JSON.parse(response.content[0]?.type === 'text' ? response.content[0].text : '{}') as Record<string, unknown>;
    expect(envelope).toMatchObject({ truncated: true, limitType: 'binary', maxBytes: 128 });
    expect(response.structuredContent).toBeUndefined();
  });

  it('enforces an aggregate budget across structured and text representations', () => {
    const response = mapResult({ ok: true as const, value: { answer: 'x'.repeat(200) } }, {
      budget: { maxTextBytes: 256, maxStructuredBytes: 256, maxBinaryBytes: 1024, maxBase64Bytes: 1024 },
    });

    const content = response.content[0];
    const envelope = JSON.parse(content && content.type === 'text' ? content.text : '{}') as Record<string, unknown>;
    expect(envelope).toMatchObject({ truncated: true, limitType: 'structured' });
    expect(response.structuredContent).toBeUndefined();
  });

  it('keeps filesystem error messages instead of Operation failed', () => {
    const response = mapError({ code: 'FILE_NOT_FOUND', message: 'File or directory was not found', recoverable: false });
    const content = response.content[0];
    expect(content?.type === 'text' ? content.text : undefined).toBe('FILE_NOT_FOUND: File or directory was not found');
  });

  it('preserves structured recovery details on provider failures', () => {
    const response = mapError({
      code: 'INTERNAL_ERROR',
      message: 'provider failed after backup',
      recoverable: true,
      details: {
        replacementRecoveryId: 'recovery-123',
        replacementRecoveryPath: 'E:\\recovery\\recovery-123\\payload',
      },
    });

    expect(response.structuredContent).toMatchObject({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Operation failed',
        recoverable: true,
        details: {
          replacementRecoveryId: 'recovery-123',
          replacementRecoveryPath: 'E:\\recovery\\recovery-123\\payload',
        },
      },
    });
  });
});
