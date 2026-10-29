import { describe, expect, it } from 'vitest';
import type { Result, ResultBudget } from '@unified-mpc/domain';
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

  it('keeps observed stdout out of the result while still delivering every line', async () => {
    const runner = new DirectProcessRunner();
    const observed: string[] = [];
    const script = "process.stdout.write('alpha\\nbeta\\ngamma\\n')";

    const result = await runner.run(process.execPath, ['-e', script], process.cwd(), {
      timeoutMs: 5_000,
      retainStdout: false,
      stopAfterStdoutLine: (line) => {
        observed.push(line);
        return false;
      },
    });

    expect(observed).toEqual(['alpha', 'beta', 'gamma']);
    expect(result.stdout).toBe('');

    // Default retention is unchanged: without the flag the same lines are buffered.
    const retained = await runner.run(process.execPath, ['-e', script], process.cwd(), {
      timeoutMs: 5_000,
      stopAfterStdoutLine: () => false,
    });
    expect(retained.stdout).toBe('alpha\nbeta\ngamma\n');
  });

  it('keeps an exact match-budget fit and stops when the next record would exceed it', async () => {
    const matchA = { path: 'src\\a.ts', line: 1, text: 'needle a' };
    const matchB = { path: 'src\\b.ts', line: 2, text: 'needle b' };
    const matchC = { path: 'src\\c.ts', line: 3, text: 'needle c' };
    const line = (match: typeof matchA): string => JSON.stringify({ type: 'match', data: { path: { text: match.path }, line_number: match.line, lines: { text: match.text } } });
    let delivered = [matchA, matchB];
    const runner: ProcessRunner = {
      async run(_command, _args, _cwd, options): Promise<ProcessRunResult> {
        let stopped = false;
        for (const match of delivered) {
          if (options?.stopAfterStdoutLine?.(line(match)) === true) {
            stopped = true;
            break;
          }
        }
        return { exitCode: 0, stderr: '', stdout: '', ...(stopped ? { stoppedEarly: true } : {}) };
      },
    };
    const resolver: ExecutableResolver = { resolve: async (): Promise<Result<string>> => ({ ok: true, value: 'rg.exe' }) };
    const adapter = new RipgrepAdapter(resolver, runner);
    const oneMatch = Buffer.byteLength(JSON.stringify(matchA), 'utf8');
    const budget = (maxStructuredBytes: number): ResultBudget => ({ maxItems: 10, maxTextBytes: 1024, maxStructuredBytes, maxBinaryBytes: 1024, maxBase64Bytes: 1024 });

    // Exactly maxStructuredBytes of matches is kept, not rejected.
    await expect(adapter.searchText({ rootPath: 'C:\\workspace', query: 'needle', maxResults: 10, resultBudget: budget(oneMatch * 2) })).resolves.toEqual({
      ok: true,
      value: { matches: [matchA, matchB], truncated: false },
    });
    delivered = [matchA, matchB, matchC];
    await expect(adapter.searchText({ rootPath: 'C:\\workspace', query: 'needle', maxResults: 10, resultBudget: budget(oneMatch * 2 - 1) })).resolves.toEqual({
      ok: true,
      value: { matches: [matchA], truncated: true },
    });
  });

  it('stops a file listing on the path after maxResults and reports truncation', async () => {
    const runner: ProcessRunner = {
      async run(_command, _args, _cwd, options): Promise<ProcessRunResult> {
        for (const path of ['src/a.ts', 'src/b.ts', 'src/c.ts']) {
          if (options?.stopAfterStdoutLine?.(path) === true) return { exitCode: 0, stderr: '', stdout: '', stoppedEarly: true };
        }
        return { exitCode: 0, stderr: '', stdout: '' };
      },
    };
    const resolver: ExecutableResolver = { resolve: async (): Promise<Result<string>> => ({ ok: true, value: 'rg.exe' }) };
    const adapter = new RipgrepAdapter(resolver, runner);

    await expect(adapter.searchFiles({ rootPath: 'C:\\workspace', maxResults: 2, discovery: 'explicit' })).resolves.toEqual({
      ok: true,
      value: { paths: ['src/a.ts', 'src/b.ts'], truncated: true },
    });
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

  it('collects bounded JSON match records from observed lines instead of retained stdout', async () => {
    let retainStdout: boolean | undefined;
    const runner: ProcessRunner = {
      async run(_command, _args, _cwd, options): Promise<ProcessRunResult> {
        retainStdout = options?.retainStdout;
        const lines = [
          JSON.stringify({ type: 'begin', data: { path: { text: 'src\\a.ts' } } }),
          JSON.stringify({ type: 'match', data: { path: { text: 'src\\a.ts' }, line_number: 3, lines: { text: 'const a = 1;\n' } } }),
          JSON.stringify({ type: 'end', data: { path: { text: 'src\\a.ts' } } }),
          JSON.stringify({ type: 'match', data: { path: { text: 'src\\b.ts' }, line_number: 4, lines: { text: 'const b = 2;\n' } } }),
        ];
        let stopped = false;
        for (const line of lines) {
          if (options?.stopAfterStdoutLine?.(line) === true) {
            stopped = true;
            break;
          }
        }
        // The raw stream is deliberately unusable: the adapter must collect from
        // the observer, not from what the runner buffered.
        return { exitCode: 0, stderr: '', stdout: 'raw-stream-must-not-be-parsed', ...(stopped ? { stoppedEarly: true } : {}) };
      },
    };
    const resolver: ExecutableResolver = { resolve: async (): Promise<Result<string>> => ({ ok: true, value: 'rg.exe' }) };
    const adapter = new RipgrepAdapter(resolver, runner);

    const result = await adapter.searchText({ rootPath: 'C:\\workspace', query: 'const', maxResults: 1 });

    expect(retainStdout).toBe(false);
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

  it('skips binary files in the fallback like ripgrep instead of decoding them', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const rootPath = await mkdtemp(path.join(tmpdir(), 'unified-mpc-search-binary-'));
    const resolver: ExecutableResolver = {
      resolve: async (): Promise<Result<string>> => ({
        ok: false,
        error: { code: 'EXECUTABLE_NOT_FOUND', message: "Executable 'rg' was not found", recoverable: true },
      }),
    };
    const adapter = new RipgrepAdapter(resolver);

    try {
      await writeFile(path.join(rootPath, 'notes.txt'), 'needle in text\n', 'utf8');
      await writeFile(path.join(rootPath, 'blob.txt'), Buffer.concat([Buffer.from([0x00, 0x01, 0x02]), Buffer.from('needle in binary\n', 'utf8')]));
      await writeFile(path.join(rootPath, 'huge.txt'), Buffer.alloc(4 * 1024 * 1024, 0));

      const result = await adapter.searchText({ rootPath, query: 'needle' });
      expect(result).toEqual({
        ok: true,
        value: {
          matches: [{ path: 'notes.txt', line: 1, text: 'needle in text' }],
          truncated: false,
        },
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('does not report a truncated result just because a large binary file was skipped', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const rootPath = await mkdtemp(path.join(tmpdir(), 'unified-mpc-search-skip-'));
    const resolver: ExecutableResolver = {
      resolve: async (): Promise<Result<string>> => ({
        ok: false,
        error: { code: 'EXECUTABLE_NOT_FOUND', message: "Executable 'rg' was not found", recoverable: true },
      }),
    };
    const adapter = new RipgrepAdapter(resolver);

    try {
      const { stat } = await import('node:fs/promises');
      const hugePath = path.join(rootPath, 'huge.txt');
      await writeFile(hugePath, Buffer.alloc(12 * 1024 * 1024, 0));
      await writeFile(path.join(rootPath, 'notes.txt'), 'needle in text\n', 'utf8');

      const result = await adapter.searchText({ rootPath, query: 'needle' });
      expect(result).toMatchObject({ ok: true, value: { truncated: false } });
      if (result.ok) expect(result.value.matches.map((match) => match.path)).toEqual(['notes.txt']);
      // The bytes on disk must not be decoded just to discover the file is binary.
      expect((await stat(hugePath)).size).toBe(12 * 1024 * 1024);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('matches a NUL byte only in the sniff window, not later in the file', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const rootPath = await mkdtemp(path.join(tmpdir(), 'unified-mpc-search-nul-'));
    const resolver: ExecutableResolver = {
      resolve: async (): Promise<Result<string>> => ({
        ok: false,
        error: { code: 'EXECUTABLE_NOT_FOUND', message: "Executable 'rg' was not found", recoverable: true },
      }),
    };
    const adapter = new RipgrepAdapter(resolver);

    try {
      const prefix = Buffer.from(`${'a'.repeat(64)}\n`.repeat(200), 'utf8');
      await writeFile(path.join(rootPath, 'late-nul.txt'), Buffer.concat([prefix, Buffer.from([0x00]), Buffer.from('\nneedle after nul\n', 'utf8')]));
      const result = await adapter.searchText({ rootPath, query: 'needle' });
      expect(result).toMatchObject({ ok: true, value: { truncated: false } });
      if (result.ok) expect(result.value.matches.map((match) => match.line)).toEqual([202]);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('applies context-economy filters to automatic discovery and allows explicit enumeration', async () => {
    let receivedArgs: readonly string[] = [];
    const runner: ProcessRunner = {
      async run(_command: string, args: readonly string[], _cwd, options): Promise<ProcessRunResult> {
        receivedArgs = args;
        if (args.includes('--files')) {
          for (const line of ['src/app.ts', '.env', 'node_modules/pkg/index.js', 'dist/app.js']) options?.stopAfterStdoutLine?.(line);
        }
        return { exitCode: 0, stderr: '', stdout: '' };
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
