import type { DiagnosticLogger } from '@unified-mpc/application';
import type { ActivityRecordErrorHandler } from '@unified-mpc/mcp-server';

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

export interface ActivityRecordErrorSinkOptions {
  /** Prefix that names the runtime which observed the failure. */
  readonly label?: string;
  /** Test seam; production writes to `process.stderr`, the runtime's only diagnostic channel. */
  readonly write?: (chunk: string) => void;
}

/**
 * Give a failed activity-sink record somewhere to go.
 *
 * `ActivityTracker` catches every sink failure so tool execution never fails,
 * and reports it through `onRecordError`. The stdio runtime supplied no handler,
 * so a permanently failing rotation (for example `mcp-activity.log.1` being a
 * directory) silently disabled retention and the log grew unbounded again.
 *
 * One line per failed record: a repeating failure is itself the signal, and
 * the line stays small enough for a bounded stderr tail. Never throws.
 */
export function createActivityRecordErrorSink(options: ActivityRecordErrorSinkOptions = {}): ActivityRecordErrorHandler {
  const label = options.label ?? 'Unified-MPC';
  const write = options.write ?? ((chunk: string): void => { process.stderr.write(chunk); });
  return (error, event): void => {
    const message = error instanceof Error ? error.message : String(error);
    try {
      write(`${label} activity record failed: tool=${event.toolName} phase=${event.phase} code=${event.resultCode} error=${message}\n`);
    } catch {
      // Diagnostics must never change the safe application result.
    }
  };
}
