import type { Readable, Writable } from 'node:stream';

export type ManagedProcessState = 'starting' | 'running' | 'exited' | 'failed' | 'stopped' | 'timed_out' | 'termination_unverified';

export interface ManagedProcessStart {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /**
   * Wall-clock cap. `0` disables the cap, for a worker whose lifetime is the
   * caller's to end and which must not be killed by a fixed hour; any other
   * value must be a positive integer.
   */
  readonly timeoutMs?: number;
  /**
   * Hand the child's pipes to the caller (`onCreated` carries them) instead of
   * draining them into the log ring buffer alone. The ring buffer keeps
   * receiving every chunk, so diagnostics do not go blind.
   */
  readonly exposeStdio?: boolean;
  /**
   * Added on top of the allowlisted base environment. Caller-owned code, not
   * ambient env: the sanitized base stays the floor, so a stripped variable is
   * only present when the caller names it here.
   */
  readonly env?: Readonly<Record<string, string>>;
}

export interface ManagedProcess {
  readonly processId: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly state: ManagedProcessState;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly exitCode?: number;
  readonly error?: string;
  /**
   * Present only on the handle `onCreated` receives for a spec that asked for
   * `exposeStdio`; `status()` and `list()` never project live handles.
   */
  readonly stdin?: Writable;
  readonly stdout?: Readable;
  readonly stderr?: Readable;
}

/**
 * Internal host identity used only for restart reconciliation.
 *
 * This is intentionally separate from ManagedProcess so raw OS process ids are
 * not projected through normal MCP process responses.
 */
export interface ManagedProcessRecoveryIdentity {
  readonly processId: string;
  readonly platform: 'linux' | 'darwin';
  readonly pid: number;
  readonly processStartedAt: string;
}

export type ProcessLogStream = 'stdout' | 'stderr';

export interface ProcessLogEntry {
  readonly sequence: number;
  readonly stream: ProcessLogStream;
  readonly text: string;
}

export interface LogQuery {
  readonly tailLines?: number;
  readonly sinceSequence?: number;
}

export interface ProcessLogResult {
  readonly entries: readonly ProcessLogEntry[];
  readonly truncated: boolean;
  readonly nextSequence: number;
}
