import { describe, expect, it } from 'vitest';
import type { Result } from '@unified-mpc/domain';
import type { ExecutableResolver } from './executable-resolver.js';
import { DirectProcessRunner, RipgrepAdapter, type ProcessRunResult, type ProcessRunner } from './ripgrep-adapter.js';

describe('RipgrepAdapter', () => {
  it('terminates an over-budget ripgrep process and reports a timed-out partial result', async () => {
    const runner = new DirectProcessRunner();
    const startedAt = Date.now();

    const result = await runner.run(
      process.execPath,
      ['-e', "setTimeout(() => process.stdout.write('late'), 2_000)"],
      process.cwd(),
      { timeoutMs: 40 },
    );

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(result.timedOut).toBe(true);
  });

  it('stops a high-volume child after enough stdout lines without retaining the full stream', async () => {
    const runner = new DirectProcessRunner();
    let observed = 0;
    const startedAt = Date.now();
    const script = [
      "let i = 0;",
      "const write = () => {",
      "  while (i < 200000 && process.stdout.write(`line-${i++}\\n`)) {}",
      "  if (i < 200000) process.stdout.once('drain', write); else setTimeout(() => {}, 2000);",
      "};",
      "write();",
    ].join(' ');

    const result = await runner.run(process.execPath, ['-e', script], process.cwd(), {
      timeoutMs: 5_000,
      stopAfterStdoutLine: () => {
        observed += 1;
        return observed > 100;
      },
    });

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(result.stoppedEarly).toBe(true);
    expect(result.timedOut).not.toBe(true);
    expect(observed).toBeGreaterThan(100);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThan(1024 * 1024);
  });

  it('terminates a ripgrep child when the MCP invocation is aborted', async () => {
    const runner = new DirectProcessRunner();
    const controller = new AbortController();
    const startedAt = Date.now();
    const abortTimer = setTimeout(() => controller.abort(), 30);

    const result = await runner.run(
      process.execPath,
      ['-e', "setTimeout(() => process.stdout.write('late'), 2_000)"],
      process.cwd(),
      { timeoutMs: 1_000, signal: controller.signal },
    );
    clearTimeout(abortTimer);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(result.timedOut).toBe(true);
    expect(result.stdout).not.toContain('late');
  });

  it('passes the invocation abort signal to process-backed text search', async () => {
    const controller = new AbortController();
    let childWasAborted = false;
    const runner: ProcessRunner = {
      async run(_command, _args, _cwd, options): Promise<ProcessRunResult> {
        return new Promise((resolve) => {
          options?.signal?.addEventListener('abort', () => {
            childWasAborted = true;
            resolve({ exitCode: -1, stdout: '', stderr: '', timedOut: true });
          }, { once: true });
          controller.abort();
        });
      },
    };
    const resolver: ExecutableResolver = { resolve: async (): Promise<Result<string>> => ({ ok: true, value: 'rg.exe' }) };
    const adapter = new RipgrepAdapter(resolver, runner);

    await expect(adapter.searchText({ rootPath: 'C:\\workspace', query: 'needle', signal: controller.signal })).resolves.toEqual({
      ok: true,
      value: { matches: [], truncated: true },
    });
    expect(childWasAborted).toBe(true);
  });

  it('passes query metacharacters as one literal argument without shell side effects', async () => {
    let executable = '';
    let receivedArgs: readonly string[] = [];
    const runner: ProcessRunner = {
      async run(command: string, args: readonly string[]): Promise<ProcessRunResult> {
        executable = command;
        receivedArgs = args;
        return { exitCode: 1, stdout: '', stderr: '' };
      },
    };
    const resolver: ExecutableResolver = { resolve: async (): Promise<Result<string>> => ({ ok: true, value: 'rg.exe' }) };
    const adapter = new RipgrepAdapter(resolver, runner);
    const query = 'literal & echo side-effect | $(not-a-command)';

    const result = await adapter.searchText({ rootPath: 'C:\\workspace', query, maxResults: 200 });

    expect(result).toEqual({ ok: true, value: { matches: [], truncated: false } });
    expect(executable).toBe('rg.exe');
    expect(receivedArgs).toContain('--no-ignore');
    expect(receivedArgs).toContain('--hidden');
    expect(receivedArgs).toContain(query);
    expect(receivedArgs).not.toContain(receivedArgs.join(' '));
  });

  it('reports malformed ripgrep arguments as INVALID_INPUT with bounded diagnostics', async () => {
    const runner: ProcessRunner = { async run(): Promise<ProcessRunResult> { return { exitCode: 2, stdout: '', stderr: 'regex parse error: unclosed group\n' }; } };
    const resolver: ExecutableResolver = { resolve: async (): Promise<Result<string>> => ({ ok: true, value: 'rg.exe' }) };
    const adapter = new RipgrepAdapter(resolver, runner);
    await expect(adapter.searchText({ rootPath: 'C:\\workspace', query: 'broken(' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('unclosed group') } });
  });

  it('asks the process runner to stop after maxResults plus one visible match', async () => {
    let stoppedByObserver = false;
    const lines = [
      JSON.stringify({ type: 'match', data: { path: { text: 'src\\a.ts' }, line_number: 1, lines: { text: 'needle a\\n' } } }),
      JSON.stringify({ type: 'match', data: { path: { text: 'src\\b.ts' }, line_number: 2, lines: { text: 'needle b\\n' } } }),
      JSON.stringify({ type: 'match', data: { path: { text: 'src\\c.ts' }, line_number: 3, lines: { text: 'needle c\\n' } } }),
    ];
    const runner: ProcessRunner = {
      async run(_command, _args, _cwd, options): Promise<ProcessRunResult> {
        const captured: string[] = [];
        for (const line of lines) {
          captured.push(line);
          if (options?.stopAfterStdoutLine?.(line) === true) {
            stoppedByObserver = true;
            break;
          }
        }
        return { exitCode: -1, stdout: captured.join('\n'), stderr: '', ...(stoppedByObserver ? { stoppedEarly: true } : {}) };
      },
    };
    const resolver: ExecutableResolver = { resolve: async (): Promise<Result<string>> => ({ ok: true, value: 'rg.exe' }) };
    const adapter = new RipgrepAdapter(resolver, runner);

    const result = await adapter.searchText({ rootPath: 'C:\\workspace', query: 'needle', maxResults: 1 });

    expect(stoppedByObserver).toBe(true);
    expect(result).toEqual({
      ok: true,
      value: {
        matches: [{ path: 'src\\a.ts', line: 1, text: 'needle a\\n' }],
        truncated: true,
      },
    });
  });

  it('parses bounded JSON match records and reports truncation', async () => {
    const runner: ProcessRunner = {
      async run(): Promise<ProcessRunResult> {
        return {
          exitCode: 0,
          stderr: '',
          stdout: [
            JSON.stringify({ type: 'match', data: { path: { text: 'src\\a.ts' }, line_number: 3, lines: { text: 'const a = 1;\n' } } }),
            JSON.stringify({ type: 'match', data: { path: { text: 'src\\b.ts' }, line_number: 4, lines: { text: 'const b = 2;\n' } } }),
          ].join('\n'),
        };
      },
    };
    const resolver: ExecutableResolver = { resolve: async (): Promise<Result<string>> => ({ ok: true, value: 'rg.exe' }) };
    const adapter = new RipgrepAdapter(resolver, runner);

    const result = await adapter.searchText({ rootPath: 'C:\\workspace', query: 'const', maxResults: 1 });

    expect(result).toEqual({
      ok: true,
      value: {
        matches: [{ path: 'src\\a.ts', line: 3, text: 'const a = 1;' }],
        truncated: true,
      },
    });
  });

  it('uses a Node filesystem fallback when ripgrep is unavailable', async () => {
    const { mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const rootPath = await mkdtemp(path.join(tmpdir(), 'unified-mpc-search-'));
    const resolver: ExecutableResolver = {
      async resolve(): Promise<Result<string>> {
        return {
          ok: false,
          error: { code: 'EXECUTABLE_NOT_FOUND', message: "Executable 'rg' was not found", recoverable: true },
        };
      },
    };
    const adapter = new RipgrepAdapter(resolver);

    try {
      await mkdir(path.join(rootPath, 'src'), { recursive: true });
      await mkdir(path.join(rootPath, 'node_modules', 'pkg'), { recursive: true });
      await writeFile(path.join(rootPath, 'src', 'a.ts'), 'needle alpha\nnope\nneedle beta\n', 'utf8');
      await writeFile(path.join(rootPath, 'node_modules', 'pkg', 'index.js'), 'needle dependency\n', 'utf8');

      await expect(adapter.searchText({ rootPath, query: 'needle', maxResults: 10 })).resolves.toEqual({
        ok: true,
        value: {
          matches: [
            { path: path.join('src', 'a.ts'), line: 1, text: 'needle alpha' },
            { path: path.join('src', 'a.ts'), line: 3, text: 'needle beta' },
          ],
          truncated: false,
        },
      });
      await expect(adapter.searchFiles({ rootPath, glob: '*.ts', maxResults: 10 })).resolves.toEqual({
        ok: true,
        value: { paths: [path.join('src', 'a.ts')], truncated: false },
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('bounds fallback search output and stops an in-flight large read when cancelled', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const rootPath = await mkdtemp(path.join(tmpdir(), 'unified-mpc-search-large-'));
    const resolver: ExecutableResolver = {
      resolve: async (): Promise<Result<string>> => ({
        ok: false,
        error: { code: 'EXECUTABLE_NOT_FOUND', message: "Executable 'rg' was not found", recoverable: true },
      }),
    };
    const adapter = new RipgrepAdapter(resolver);

    try {
      await writeFile(path.join(rootPath, 'large.txt'), `${'needle '.repeat(256)}\n`.repeat(20_000), 'utf8');
      const bounded = await adapter.searchText({
        rootPath,
        query: 'needle',
        maxResults: 500,
        resultBudget: { maxItems: 500, maxTextBytes: 1024, maxStructuredBytes: 256, maxBinaryBytes: 1024, maxBase64Bytes: 1024 },
      });
      expect(bounded).toMatchObject({ ok: true, value: { truncated: true } });
      if (bounded.ok) expect(bounded.value.matches.length).toBeLessThan(500);

      const controller = new AbortController();
      const pending = adapter.searchText({ rootPath, query: 'needle', signal: controller.signal });
      setImmediate(() => controller.abort());
      await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('applies context-economy filters to automatic discovery and allows explicit enumeration', async () => {
    let receivedArgs: readonly string[] = [];
    const runner: ProcessRunner = {
      async run(_command: string, args: readonly string[]): Promise<ProcessRunResult> {
        receivedArgs = args;
        return { exitCode: 0, stderr: '', stdout: ['src/app.ts', '.env', 'node_modules/pkg/index.js', 'dist/app.js'].join('\n') };
      },
    };
    const resolver: ExecutableResolver = { resolve: async (): Promise<Result<string>> => ({ ok: true, value: 'rg.exe' }) };
    const adapter = new RipgrepAdapter(resolver, runner);

    const automatic = await adapter.searchFiles({ rootPath: 'C:\\workspace' });
    expect(automatic).toEqual({ ok: true, value: { paths: ['src/app.ts', '.env'], truncated: false } });
    expect(receivedArgs).toContain('!**/node_modules/**');

    await adapter.searchText({ rootPath: 'C:\\workspace', query: 'needle' });
    expect(receivedArgs).not.toContain('--binary-files');

    const explicit = await adapter.searchFiles({ rootPath: 'C:\\workspace', discovery: 'explicit' });
    expect(explicit).toEqual({
      ok: true,
      value: { paths: ['src/app.ts', '.env', 'node_modules/pkg/index.js', 'dist/app.js'], truncated: false },
    });
  });
});
