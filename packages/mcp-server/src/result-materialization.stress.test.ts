import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import { ok, type ResultBudget } from '@unified-mpc/domain';
import { ContextEngine } from './context-engine.js';
import { mapResult } from './result-mapper.js';
import type { McpApplicationServices } from './tools/tool-types.js';

const MIB = 1024 * 1024;
const OUTPUT_BUDGET = 64 * 1024;
const PEAK_HEAP_ALLOWANCE = 16 * MIB;
const PEAK_RSS_ALLOWANCE = 32 * MIB;
const MAX_MAPPING_MS = 750;

describe('result materialization stress regressions', () => {
  it.each([10, 50, 100])('bounds a %d MiB object-shaped result without full serialization', (sizeMiB) => {
    const payload = 'x'.repeat(sizeMiB * MIB);
    expect(Buffer.byteLength(payload, 'utf8')).toBe(sizeMiB * MIB);
    const value = { payload };
    const stringify = vi.spyOn(JSON, 'stringify');
    const before = process.memoryUsage();
    const started = performance.now();

    const response = mapResult({ ok: true as const, value }, { maxBytes: OUTPUT_BUDGET });

    const elapsedMs = performance.now() - started;
    const after = process.memoryUsage();
    expect(stringify.mock.calls.some(([candidate]) => candidate === value)).toBe(false);
    stringify.mockRestore();
    expect(JSON.parse(response.content[0]?.type === 'text' ? response.content[0].text : '{}'))
      .toMatchObject({ truncated: true, maxBytes: OUTPUT_BUDGET });
    expect(Math.max(0, after.heapUsed - before.heapUsed)).toBeLessThan(PEAK_HEAP_ALLOWANCE);
    expect(Math.max(0, after.rss - before.rss)).toBeLessThan(PEAK_RSS_ALLOWANCE);
    expect(elapsedMs).toBeLessThan(MAX_MAPPING_MS);
  }, 15_000);

  it('observes cancellation after a huge file result without serializing that result first', async () => {
    const payload = 'x'.repeat(100 * MIB);
    expect(Buffer.byteLength(payload, 'utf8')).toBe(100 * MIB);
    const largeResult = {
      path: 'huge.txt',
      content: payload,
      startLine: 1,
      endLine: 1,
      encoding: 'utf8' as const,
    };
    let reads = 0;
    const controller = new AbortController();
    const services: McpApplicationServices = {
      workspaceInfo: {
        async list() { return ok([{ id: 'workspace-1' }]); },
      },
      file: {
        async readFile() {
          reads += 1;
          controller.abort();
          return ok(largeResult);
        },
      },
    };
    const stringify = vi.spyOn(JSON, 'stringify');
    const before = process.memoryUsage();
    const started = performance.now();

    const result = await new ContextEngine(services, { clientId: 'stress', clientName: 'stress' }).readMany({
      workspaceId: 'workspace-1',
      files: [{ path: 'huge.txt' }, { path: 'never-read.txt' }],
    }, undefined, controller.signal);

    const elapsedMs = performance.now() - started;
    const after = process.memoryUsage();
    expect(stringify.mock.calls.some(([candidate]) => candidate === largeResult)).toBe(false);
    stringify.mockRestore();
    expect(reads).toBe(1);
    expect(result).toMatchObject({
      ok: true,
      value: {
        totalFiles: 2,
        files: [
          { path: 'huge.txt', result: largeResult },
          { path: 'never-read.txt', error: { code: 'PROCESS_TIMEOUT' } },
        ],
      },
    });
    expect(Math.max(0, after.heapUsed - before.heapUsed)).toBeLessThan(PEAK_HEAP_ALLOWANCE);
    expect(Math.max(0, after.rss - before.rss)).toBeLessThan(PEAK_RSS_ALLOWANCE);
    expect(elapsedMs).toBeLessThan(MAX_MAPPING_MS);
  }, 15_000);

  it('bounds many-file accounting when a producer ignores its result budget', async () => {
    const payload = 'x'.repeat(100 * MIB);
    expect(Buffer.byteLength(payload, 'utf8')).toBe(100 * MIB);
    const largeResult = {
      path: 'huge.txt',
      content: payload,
      startLine: 1,
      endLine: 1,
      encoding: 'utf8' as const,
    };
    let reads = 0;
    const services: McpApplicationServices = {
      workspaceInfo: {
        async list() { return ok([{ id: 'workspace-1' }]); },
      },
      file: {
        async readFile() {
          reads += 1;
          return ok(largeResult);
        },
      },
    };
    const budget: ResultBudget = {
      maxItems: 2,
      maxTextBytes: OUTPUT_BUDGET,
      maxStructuredBytes: OUTPUT_BUDGET,
      maxBinaryBytes: OUTPUT_BUDGET,
      maxBase64Bytes: OUTPUT_BUDGET,
    };
    const stringify = vi.spyOn(JSON, 'stringify');
    const before = process.memoryUsage();
    const started = performance.now();

    const result = await new ContextEngine(services, { clientId: 'stress', clientName: 'stress' }).readMany({
      workspaceId: 'workspace-1',
      files: [{ path: 'huge.txt' }, { path: 'never-read.txt' }],
    }, budget);

    const elapsedMs = performance.now() - started;
    const after = process.memoryUsage();
    expect(stringify.mock.calls.some(([candidate]) => candidate === largeResult)).toBe(false);
    stringify.mockRestore();
    expect(reads).toBe(1);
    expect(result).toMatchObject({ ok: true, value: { totalFiles: 1 } });
    expect(Math.max(0, after.heapUsed - before.heapUsed)).toBeLessThan(PEAK_HEAP_ALLOWANCE);
    expect(Math.max(0, after.rss - before.rss)).toBeLessThan(PEAK_RSS_ALLOWANCE);
    expect(elapsedMs).toBeLessThan(MAX_MAPPING_MS);
  }, 15_000);
});
