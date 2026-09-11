import type { ChildProcess } from 'node:child_process';
import { PosixProcessTree } from './posix-process-tree.js';

/**
 * POSIX process-tree termination contract.
 *
 * Implementations must return only after the owned process tree is known to
 * be gone. A rejected promise means that ownership or termination could not
 * be proven; callers must keep the task in an unverified state.
 */
export interface ProcessTreeTerminator {
  stop(child: ChildProcess, pid: number): Promise<void>;
}

/** Create POSIX process tree terminator. */
export function createProcessTreeTerminator(platform: NodeJS.Platform = process.platform): ProcessTreeTerminator {
  return new PosixProcessTree({ platform });
}
