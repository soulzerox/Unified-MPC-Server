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
