import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Result } from '@unified-mpc/domain';
import type { ExecutableResolver } from './executable-resolver.js';
import { RipgrepAdapter } from './ripgrep-adapter.js';

const MIB = 1024 * 1024;
const BINARY_MIB = 64;
const CORPUS_FILES = 8;
const CORPUS_FILE_BYTES = 512 * 1024;
const WIDE_FILES = 32;
const PEAK_HEAP_ALLOWANCE = 24 * MIB;
const WIDE_PEAK_HEAP_ALLOWANCE = 16 * MIB;
const RETENTION_ALLOWANCE = 8 * MIB;
const MAX_SEARCH_MS = 20_000;

/**
 * #14 acceptance item 8: peak memory while searching must not scale with the
 * bytes on disk. The fallback streams text and sniffs binaries, so a large
 * zero-filled file must cost one chunk, not its whole size in heap.
 */
const missingRipgrep: ExecutableResolver = {
  resolve: async (): Promise<Result<string>> => ({
    ok: false,
    error: { code: 'EXECUTABLE_NOT_FOUND', message: "Executable 'rg' was not found", recoverable: true },
  }),
};

interface HeapSampler {
  stop(): number;
}

function startHeapSampler(): HeapSampler {
  let peak = process.memoryUsage().heapUsed;
  const timer = setInterval(() => {
    const used = process.memoryUsage().heapUsed;
    if (used > peak) peak = used;
  }, 2);
  timer.unref();
  return {
    stop(): number {
      clearInterval(timer);
      const used = process.memoryUsage().heapUsed;
      return Math.max(peak, used);
    },
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

function textFile(token: string): string {
  const line = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor\n';
  const lines = Math.ceil(CORPUS_FILE_BYTES / line.length);
  const body = line.repeat(lines);
  return `${body}${token}\n${body}`;
}

describe('fallback search peak memory stress', () => {
  const adapter = new RipgrepAdapter(missingRipgrep);
  let rootPath = '';

  beforeAll(async () => {
    rootPath = await mkdtemp(path.join(tmpdir(), 'unified-mpc-search-stress-'));
    await writeFile(path.join(rootPath, 'binary.log'), Buffer.alloc(BINARY_MIB * MIB, 0));
    for (let index = 0; index < CORPUS_FILES; index += 1) {
      await writeFile(
        path.join(rootPath, `corpus-${index}.txt`),
        textFile(`needle-${index}`),
        'utf8',
      );
    }
    const wideDir = path.join(rootPath, 'wide');
    await mkdir(wideDir);
    for (let index = 0; index < WIDE_FILES; index += 1) {
      await writeFile(
        path.join(wideDir, `wide-${index}.txt`),
        textFile(index === 0 ? 'wide-needle' : `filler-${index}`),
        'utf8',
      );
    }
    await settle();
  }, 60_000);

  afterAll(async () => {
    if (rootPath.length > 0) await rm(rootPath, { recursive: true, force: true });
  });

  it('keeps peak heap far below the size of a skipped binary file', async () => {
    await settle();
    const baseline = process.memoryUsage().heapUsed;
    const sampler = startHeapSampler();
    const startedAt = performance.now();

    const result = await adapter.searchText({ rootPath, query: 'needle-' });

    const elapsedMs = performance.now() - startedAt;
    const peak = sampler.stop();

    expect(result).toMatchObject({ ok: true, value: { truncated: false } });
    if (result.ok) {
      expect(result.value.matches.map((match) => match.path).sort()).toEqual(
        Array.from({ length: CORPUS_FILES }, (_, index) => `corpus-${index}.txt`),
      );
    }
    // Decoding the 64 MiB binary would cost at least its own size in heap.
    expect(Math.max(0, peak - baseline)).toBeLessThan(PEAK_HEAP_ALLOWANCE);
    expect(elapsedMs).toBeLessThan(MAX_SEARCH_MS);
  }, 60_000);

  it('does not grow peak heap with the number of text files scanned', async () => {
    await settle();
    const baseline = process.memoryUsage().heapUsed;
    const sampler = startHeapSampler();
    const startedAt = performance.now();

    const result = await adapter.searchText({ rootPath: path.join(rootPath, 'wide'), query: 'wide-needle' });

    const elapsedMs = performance.now() - startedAt;
    const peak = sampler.stop();

    expect(result).toMatchObject({ ok: true, value: { truncated: false } });
    if (result.ok) expect(result.value.matches.map((match) => match.path)).toEqual(['wide-0.txt']);
    expect(Math.max(0, peak - baseline)).toBeLessThan(WIDE_PEAK_HEAP_ALLOWANCE);
    expect(elapsedMs).toBeLessThan(MAX_SEARCH_MS);
  }, 60_000);

  it('does not retain heap across repeated searches', async () => {
    await adapter.searchText({ rootPath, query: 'needle-' });
    await settle();
    const baseline = process.memoryUsage().heapUsed;

    for (let index = 0; index < 3; index += 1) {
      const result = await adapter.searchText({ rootPath, query: 'needle-' });
      expect(result).toMatchObject({ ok: true, value: { truncated: false } });
      await settle();
    }

    expect(Math.max(0, process.memoryUsage().heapUsed - baseline)).toBeLessThan(RETENTION_ALLOWANCE);
  }, 120_000);
});
