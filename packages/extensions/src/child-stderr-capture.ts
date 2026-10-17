const DEFAULT_MAX_BYTES = 4 * 1024;

export interface ChildStderrCapture {
  /** Whitespace-collapsed tail of what the child wrote, newest bytes last. */
  readonly tail: () => string;
  readonly drain: () => void;
}

function isDrainableStderr(value: unknown): value is {
  on(event: 'data' | 'error', listener: (chunk?: unknown) => void): unknown;
  removeListener(event: 'data' | 'error', listener: (chunk?: unknown) => void): unknown;
  resume(): unknown;
} {
  return typeof value === 'object'
    && value !== null
    && 'on' in value && typeof value.on === 'function'
    && 'removeListener' in value && typeof value.removeListener === 'function'
    && 'resume' in value && typeof value.resume === 'function';
}

/**
 * Retain a bounded tail of a child MCP server's stderr (#210 U33).
 *
 * A child that dies before handshaking used to leave nothing but the SDK's
 * `Connection closed`. The reason — a native fault line, an attestation
 * denial, an interpreter error — is on the child's stderr and was being
 * drained into the void. Keeping the newest bytes lets the host report what
 * the worker actually said, while the bound stops a chatty child from
 * growing memory.
 *
 * ponytail: retention is stderr text only; the child's exit code/signal is
 * not reachable through the MCP transport. Add a spawn wrapper if a signal
 * distinction (SIGSEGV vs exit 1) is ever needed.
 */
export function captureChildStderr(stderr: unknown, options: { readonly maxBytes?: number } = {}): ChildStderrCapture {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('maxBytes must be a positive safe integer');
  }
  if (!isDrainableStderr(stderr)) return { tail: () => '', drain: () => undefined };

  const chunks: Buffer[] = [];
  let size = 0;
  const onData = (chunk?: unknown): void => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''), 'utf8');
    chunks.push(buffer);
    size += buffer.length;
    while (size > maxBytes && chunks.length > 0) {
      const head = chunks[0]!;
      const overflow = size - maxBytes;
      if (head.length <= overflow) {
        chunks.shift();
        size -= head.length;
        continue;
      }
      chunks[0] = head.subarray(overflow);
      size -= overflow;
    }
  };
  const ignorePipeError = (): void => undefined;
  stderr.on('data', onData);
  stderr.on('error', ignorePipeError);
  stderr.resume();

  let drained = false;
  return {
    tail: (): string => Buffer.concat(chunks).toString('utf8').replace(/\s+/g, ' ').trim(),
    drain: (): void => {
      if (drained) return;
      drained = true;
      stderr.removeListener('data', onData);
      stderr.removeListener('error', ignorePipeError);
    },
  };
}

/** Append a child's retained stderr to a transport failure, when it said anything. */
export function withChildStderr(error: unknown, childStderr: string): Error {
  const message = error instanceof Error ? error.message : 'Child MCP operation failed';
  const failure = new Error(childStderr.length === 0 ? message : `${message} (child stderr: ${childStderr})`);
  if (error instanceof Error && typeof error.stack === 'string') failure.stack = error.stack;
  return failure;
}
