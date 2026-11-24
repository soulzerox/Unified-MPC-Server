import { Client, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/client';
import type { Result } from '@unified-mpc/domain';
import type { Readable, Writable } from 'node:stream';
import { mcpClientSession } from './mcp-session-manager.js';
import type { McpClientFactory, McpClientSession } from './mcp-session-manager.js';
import type { McpServerLaunchConfig } from './types.js';

/** The child's own pipes, as the supervisor holds them. */
export interface CapabilityWorkerPipes {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
}

/**
 * The two calls the factory makes on the capability runtime, structural so this
 * package needs no dependency on it: a lease from the registry, pipes from the
 * supervisor.
 */
export interface CapabilityWorkerSource {
  acquire(id: string): Promise<Result<{ readonly release: () => Result<void> }>>;
  pipes(id: string): CapabilityWorkerPipes | undefined;
}

export interface ProcessManagerMcpClientFactoryOptions {
  /** Registry plus supervisor, as one source: the factory needs nothing else. */
  readonly source: CapabilityWorkerSource;
  readonly manifestId: string;
  /** What the runtime already computed, so a mismatched config is caught here. */
  readonly launch: { readonly command: string; readonly args: readonly string[]; readonly cwd?: string };
  /**
   * A release the registry refused has no caller left to return it to: the
   * session is closing. Reported here rather than dropped on the floor.
   */
  readonly onReleaseError?: (error: unknown) => void;
}

/** A child that never emits a frame boundary must fail the transport, not grow memory. */
const MAX_UNTERMINATED_FRAME_BYTES = 1_048_576;

/** Newline-delimited JSON-RPC over a supervised child's own pipes. */
export class PipeTransport implements Transport {
  public onclose?: () => void;

  public onerror?: (error: Error) => void;

  public onmessage?: (message: JSONRPCMessage) => void;

  private buffered = '';

  private detached = false;

  private readonly onData = (chunk: Buffer): void => this.receive(chunk.toString('utf8'));

  private readonly onEnd = (): void => this.detach();

  private readonly onFailure = (error: Error): void => {
    this.onerror?.(error);
    this.detach();
  };

  public constructor(private readonly pipes: CapabilityWorkerPipes) {}

  public async start(): Promise<void> {
    if (this.detached) throw new Error('transport is closed');
    this.pipes.stdout.on('data', this.onData);
    this.pipes.stdout.once('end', this.onEnd);
    this.pipes.stdout.once('close', this.onEnd);
    this.pipes.stdout.once('error', this.onFailure);
    this.pipes.stdin.once('error', this.onFailure);
  }

  public async send(message: JSONRPCMessage): Promise<void> {
    if (this.detached) throw new Error('transport is closed');
    await new Promise<void>((resolve, reject) => {
      this.pipes.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error === null || error === undefined) resolve();
        else reject(error);
      });
    });
  }

  /** Detaches only: the lease holder owns the process, not this transport. */
  public async close(): Promise<void> {
    this.detach();
  }

  private receive(chunk: string): void {
    if (this.buffered.length + chunk.length > MAX_UNTERMINATED_FRAME_BYTES) {
      this.onFailure(new Error(`capability worker wrote more than ${MAX_UNTERMINATED_FRAME_BYTES} bytes without a frame boundary`));
      return;
    }
    this.buffered += chunk;
    let newline = this.buffered.indexOf('\n');
    while (newline >= 0) {
      const frame = this.buffered.slice(0, newline).trim();
      this.buffered = this.buffered.slice(newline + 1);
      newline = this.buffered.indexOf('\n');
      if (frame.length === 0) continue;
      try {
        this.onmessage?.(JSON.parse(frame) as JSONRPCMessage);
      } catch (error: unknown) {
        // A malformed frame means the stream can no longer be trusted: report it
        // once and stop reading rather than deliver a half-parsed conversation.
        this.onFailure(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  }

  private detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.pipes.stdout.off('data', this.onData);
    this.pipes.stdout.off('end', this.onEnd);
    this.pipes.stdout.off('close', this.onEnd);
    this.pipes.stdout.off('error', this.onFailure);
    this.pipes.stdin.off('error', this.onFailure);
    this.onclose?.();
  }
}

/**
 * `McpClientFactory` for a worker the capability runtime supervises.
 *
 * `connect` takes the lease first, then connects over the pipes the supervisor
 * spawned. The returned session's `close` releases the lease, which is what
 * leaves the worker `WARM_IDLE` and reclaimable under pressure instead of
 * resident for the driver's whole lifetime. A release the registry refuses is
 * reported through `onReleaseError`, not dropped.
 */
export class ProcessManagerMcpClientFactory implements McpClientFactory {
  public constructor(private readonly options: ProcessManagerMcpClientFactoryOptions) {}

  public async connect(config: McpServerLaunchConfig, signal?: AbortSignal): Promise<McpClientSession> {
    const { manifestId, launch } = this.options;
    if (config.type !== undefined && config.type !== 'stdio') {
      throw new Error(`capability ${manifestId} is a supervised process and cannot serve a ${config.type} transport`);
    }
    if (config.command !== launch.command
      || (config.cwd ?? undefined) !== launch.cwd
      || (config.args ?? []).join('\u0000') !== launch.args.join('\u0000')) {
      throw new Error(`capability ${manifestId} was asked to connect with a launch config it was not registered for`);
    }

    const lease = await this.options.source.acquire(manifestId);
    if (!lease.ok) {
      throw new Error(`capability ${manifestId} refused the lease: ${lease.error.message}`);
    }
    let released = false;
    const reportRelease = this.options.onReleaseError ?? ((error: unknown): void => {
      process.stderr.write(`capability ${manifestId} lease release refused: ${error instanceof Error ? error.message : String(error)}\n`);
    });
    const release = (): void => {
      if (released) return;
      released = true;
      const closed = lease.value.release();
      if (!closed.ok) reportRelease(closed.error);
    };

    try {
      const pipes = this.options.source.pipes(manifestId);
      if (pipes === undefined) {
        throw new Error(`capability ${manifestId} is leased but exposes no pipes`);
      }
      // `legacy`, not `auto`: a custom transport probes `server/discover` in
      // place, and a worker that ignores it costs the whole probe timeout on
      // every connect before falling back. The supervised workers are 2025-era
      // servers, so the plain `initialize` handshake is the honest sequence.
      const client = new Client(
        { name: 'unified-mpc-capability-worker', version: '1.0.0' },
        { versionNegotiation: { mode: 'legacy' } },
      );
      await client.connect(new PipeTransport(pipes), signal === undefined ? undefined : { signal });
      return mcpClientSession(client, async () => {
        try {
          await client.close().catch(() => undefined);
        } finally {
          release();
        }
      });
    } catch (error: unknown) {
      release();
      throw error;
    }
  }
}
