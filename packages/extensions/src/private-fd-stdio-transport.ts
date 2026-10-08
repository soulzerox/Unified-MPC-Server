import { spawn, type ChildProcess } from 'node:child_process';
import { Writable } from 'node:stream';
import { getDefaultEnvironment, type StdioClientTransport } from '@modelcontextprotocol/client/stdio';

type MCPMessage = Parameters<StdioClientTransport['send']>[0];

export interface PrivateFdStdioClientTransportOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Sensitive, caller-owned buffer: ownership transfers to start(), which wipes it. */
  readonly bootstrap: Buffer;
  /** Tests only. Non-Linux targets fail closed rather than using env/argv. */
  readonly platform?: NodeJS.Platform;
}

const MAX_BOOTSTRAP = 128 * 1024;
const MAX_FRAME = 8 * 1024 * 1024;
const BOOTSTRAP_TIMEOUT_MS = 2_000;

function denied(): Error {
  return new Error('private_fd_bootstrap_denied');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref(); });
}

/**
 * Opt-in Linux MCP stdio transport with a dedicated PRIVATE child fd3.
 *
 * fd0/1 stay JSON-RPC stdio, fd2 is drained, fd3 carries raw bootstrap
 * bytes (never argv/env/stdin). The caller MUST NOT reuse the secret after
 * passing its Buffer: start() wipes it even if child launch fails.
 *
 * This is a transport primitive, not an enabled production native provider.
 * It deliberately does not modify the generic external MCP client factory.
 */
export class PrivateFdStdioClientTransport {
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: (message: MCPMessage) => void;

  private child: ChildProcess | undefined;
  private readBuffer = Buffer.alloc(0);
  private started = false;
  private closed = false;
  private reportedClose = false;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly options: PrivateFdStdioClientTransportOptions) {}

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  async start(): Promise<void> {
    if (this.started || this.closed) throw denied();
    this.started = true;
    const secret = this.options.bootstrap;
    if (!Buffer.isBuffer(secret) || secret.byteLength < 1
      || secret.byteLength > MAX_BOOTSTRAP
      || (this.options.platform ?? process.platform) !== 'linux'
      || typeof this.options.command !== 'string' || !this.options.command.trim()
      || this.options.args?.some((entry) => typeof entry !== 'string')) {
      if (Buffer.isBuffer(secret)) secret.fill(0);
      this.closed = true;
      throw denied();
    }

    try {
      const child = spawn(this.options.command, [...(this.options.args ?? [])], {
        shell: false,
        cwd: this.options.cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        env: {
          ...getDefaultEnvironment(),
          ...(this.options.env ?? {}),
          THAI_RAG_EXTERNAL_AUTH_MODE: 'strict',
          THAI_RAG_EXTERNAL_AUTH_FD: '3',
        },
      });
      this.child = child;
      child.on('close', () => {
        if (this.child === child) this.child = undefined;
        this.reportClose();
      });
      child.on('error', (error: Error) => { this.onerror?.(error); });
      child.stdin?.on('error', (error: Error) => { this.onerror?.(error); });
      child.stdout?.on('data', (bytes: Buffer) => { this.readMessages(bytes); });
      child.stdout?.on('error', (error: Error) => { this.onerror?.(error); });
      // Never reflect worker stderr to a user/log (could contain sensitive data).
      child.stderr?.on('error', () => undefined);
      child.stderr?.resume();

      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      const fd3 = child.stdio[3];
      if (!(fd3 instanceof Writable)) throw denied();
      await new Promise<void>((resolve, reject) => {
        let finished = false;
        const finish = (error?: Error): void => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          fd3.removeListener('error', onError);
          child.removeListener('exit', onExit);
          if (error) reject(error);
          else resolve();
        };
        const onError = (): void => finish(denied());
        const onExit = (): void => finish(denied());
        const timer = setTimeout(() => finish(denied()), BOOTSTRAP_TIMEOUT_MS);
        timer.unref();
        fd3.once('error', onError);
        child.once('exit', onExit);
        fd3.end(secret, () => finish());
      });
    } catch {
      this.closed = true;
      await this.terminateChild();
      throw denied();
    } finally {
      secret.fill(0);
    }
  }

  async send(message: MCPMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (!this.started || this.closed || !stdin?.writable) throw denied();
    const bytes = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(bytes, 'utf8') > MAX_FRAME) throw denied();
    await new Promise<void>((resolve, reject) => {
      stdin.write(bytes, (error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    if (Buffer.isBuffer(this.options.bootstrap)) this.options.bootstrap.fill(0);
    this.closePromise = this.terminateChild().finally(() => this.reportClose());
    return this.closePromise;
  }

  private reportClose(): void {
    if (this.reportedClose) return;
    this.reportedClose = true;
    this.closed = true;
    this.readBuffer = Buffer.alloc(0);
    this.onclose?.();
  }

  private readMessages(bytes: Buffer): void {
    if (this.closed) return;
    try {
      this.readBuffer = Buffer.concat([this.readBuffer, bytes]);
      if (this.readBuffer.byteLength > MAX_FRAME) throw denied();
      let offset = this.readBuffer.indexOf(10);
      while (offset >= 0) {
        const line = this.readBuffer.subarray(0, offset).toString('utf8');
        this.readBuffer = this.readBuffer.subarray(offset + 1);
        if (!line.trim()) throw denied();
        const decoded: unknown = JSON.parse(line);
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw denied();
        this.onmessage?.(decoded as MCPMessage);
        offset = this.readBuffer.indexOf(10);
      }
    } catch {
      this.onerror?.(denied());
      void this.close();
    }
  }

  private async terminateChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      child.stdio[3]?.destroy();
      child.stdin?.end();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        await Promise.race([exited, delay(400)]);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await Promise.race([exited, delay(400)]);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await Promise.race([exited, delay(400)]);
      }
    } finally {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (this.child === child) this.child = undefined;
    }
  }
}
