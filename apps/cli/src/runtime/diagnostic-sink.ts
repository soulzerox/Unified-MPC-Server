import type { DiagnosticLogger } from '@unified-mpc/application';

export interface StderrDiagnosticSinkOptions {
  /** Prefix that names the runtime which observed the exception. */
  readonly label?: string;
  /** Test seam; production writes to `process.stderr`, the runtime's only diagnostic channel. */
  readonly write?: (chunk: string) => void;
}

/**
 * Give an internal exception somewhere to go (#766).
 *
 * `sanitizeException` deliberately replaces a thrown error with
 * `INTERNAL_ERROR: Operation failed` before it reaches an MCP client, and hands
 * the redacted message and stack to a `DiagnosticLogger`. No runtime ever
 * supplied one, so the reason was discarded: killing a Thai-RAG provider child
 * produced a generic tool error and not a single journal line, which made a
 * self-healing reconnect look like a permanent wedge.
 *
 * The sanitizer already redacts credentials and caps the text at 8 KiB, so this
 * sink only formats. It writes one record per failure and never throws: a
 * broken stderr must not change the safe result the client already received.
 */
export function createStderrDiagnosticSink(options: StderrDiagnosticSinkOptions = {}): DiagnosticLogger {
  const label = options.label ?? 'Unified-MPC';
  const write = options.write ?? ((chunk: string): void => { process.stderr.write(chunk); });
  return (event): void => {
    const stack = event.stack === undefined ? '' : `\n${event.stack}`;
    try {
      write(`${label} internal error name=${event.name} message=${event.message}${stack}\n`);
    } catch {
      // Diagnostics must never change the safe application result.
    }
  };
}
