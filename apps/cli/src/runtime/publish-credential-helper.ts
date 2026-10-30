import fs from 'node:fs';
import type { Readable } from 'node:stream';
import {
  PUBLISH_CREDENTIAL_DESCRIPTOR_FD_ENV,
  PUBLISH_CREDENTIAL_DESCRIPTOR_MAX_BYTES,
  PUBLISH_CREDENTIAL_LEASE_ID_ENV,
  PUBLISH_CREDENTIAL_PROMPT_MAX_BYTES,
  formatPublishCredentialBlock,
  isPublishCredentialLeaseId,
  normalizePublishCredentialPromptHost,
  parsePublishCredentialDescriptorAnswer,
  parsePublishCredentialDescriptorFd,
  parsePublishCredentialPrompt,
} from '@unified-mpc/domain';

/**
 * `<deployment>/publish-credential-helper` (#297 §3, S2b).
 *
 * Git appends exactly one operation and writes a `key=value` prompt on stdin.
 * Only `get` answers, and it answers only when all of these hold:
 *
 *   - the environment names a valid lease id and a non-stdio descriptor fd,
 *   - the prompt protocol is `https` and its normalized host is in the lease,
 *   - the host wrote a valid descriptor answer for *that* lease,
 *   - the lease has not expired.
 *
 * The helper is deliberately mute on every other path: no stdout, no stderr,
 * no file, no log. Git turns exit 1 into its own authentication failure, and
 * the operator reads the reason from `unified-mpc publish-credential status`,
 * which never needs the prompt bytes this process just discarded.
 *
 * Nothing here is reachable from a tool caller. A process that runs the helper
 * directly still gets nothing, because the secret only exists in the answer the
 * host process writes to the inherited descriptor while the lease is live.
 */

/** The helper refuses with one code so a Git child sees a plain auth failure. */
export const PUBLISH_CREDENTIAL_HELPER_REFUSED = 1;

/**
 * A host process that never answers must not hang a user's push forever. Git
 * writes its prompt immediately after the spawn and the descriptor answer is
 * written before the spawn returns, so this is only a stuck-peer guard.
 */
const PUBLISH_CREDENTIAL_HELPER_READ_TIMEOUT_MS = 15_000;

/** Injected so the contract tests never need a child process, a pipe or a clock. */
export interface PublishCredentialHelperIo {
  /** `process.argv.slice(2)`: Git's single operation argument. */
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Bounded read of the Git prompt on stdin. `null` means unreadable or too large. */
  readonly readPrompt: (limit: number) => Promise<string | null>;
  /** Bounded read of the host descriptor answer. `null` means unreadable or too large. */
  readonly readDescriptor: (fd: number, limit: number) => Promise<string | null>;
  /** The one channel a successful `get` writes to. */
  readonly writeStdout: (text: string) => void;
  readonly now: () => number;
}

/**
 * Answer one Git credential request. Returns the process exit code and writes
 * to stdout only for a successful `get`.
 */
export async function runPublishCredentialHelper(io: PublishCredentialHelperIo): Promise<number> {
  // Git appends exactly one operation. Anything else is not this helper's shape.
  if (io.argv.length !== 1 || io.argv[0] !== 'get') return PUBLISH_CREDENTIAL_HELPER_REFUSED;

  const leaseId = io.env[PUBLISH_CREDENTIAL_LEASE_ID_ENV];
  if (!isPublishCredentialLeaseId(leaseId)) return PUBLISH_CREDENTIAL_HELPER_REFUSED;

  const descriptorFd = parsePublishCredentialDescriptorFd(io.env[PUBLISH_CREDENTIAL_DESCRIPTOR_FD_ENV]);
  if (descriptorFd === null) return PUBLISH_CREDENTIAL_HELPER_REFUSED;

  const promptText = await io.readPrompt(PUBLISH_CREDENTIAL_PROMPT_MAX_BYTES);
  if (promptText === null) return PUBLISH_CREDENTIAL_HELPER_REFUSED;
  const prompt = parsePublishCredentialPrompt(promptText);
  if (prompt === null || prompt.protocol !== 'https') return PUBLISH_CREDENTIAL_HELPER_REFUSED;
  const host = normalizePublishCredentialPromptHost(prompt.host);
  if (host === null) return PUBLISH_CREDENTIAL_HELPER_REFUSED;

  const answerText = await io.readDescriptor(descriptorFd, PUBLISH_CREDENTIAL_DESCRIPTOR_MAX_BYTES);
  if (answerText === null) return PUBLISH_CREDENTIAL_HELPER_REFUSED;
  const answer = parsePublishCredentialDescriptorAnswer(answerText);
  if (answer === null) return PUBLISH_CREDENTIAL_HELPER_REFUSED;
  // A descriptor for a different lease is a programming error, never a fallback.
  if (answer.leaseId !== leaseId) return PUBLISH_CREDENTIAL_HELPER_REFUSED;
  if (answer.expiresAt <= io.now()) return PUBLISH_CREDENTIAL_HELPER_REFUSED;
  // The host checks this too; the helper checks it again so a direct invocation
  // with a forged prompt cannot be answered even by a cooperative descriptor.
  if (!answer.hosts.includes(host)) return PUBLISH_CREDENTIAL_HELPER_REFUSED;

  const block = formatPublishCredentialBlock(answer.username, answer.secret);
  if (block === null) return PUBLISH_CREDENTIAL_HELPER_REFUSED;
  io.writeStdout(block);
  return 0;
}

/**
 * The real process wiring: stdin, the inherited descriptor, stdout and the
 * wall clock. It adds nothing the injected contract does not already decide.
 */
export async function runPublishCredentialHelperProcess(): Promise<number> {
  return runPublishCredentialHelper({
    argv: process.argv.slice(2),
    env: process.env,
    readPrompt: (limit) => readBoundedStream(process.stdin, limit),
    readDescriptor: (fd, limit) => readBoundedDescriptor(fd, limit),
    writeStdout: (text) => {
      process.stdout.write(text);
    },
    now: Date.now,
  });
}

/**
 * Read one pipe to EOF without exceeding `limit`. The timeout, not the payload,
 * is what ends a peer that never closes its end.
 *
 * Exported so the bounds are testable with a short timeout; production always
 * uses the default.
 */
export async function readBoundedStream(
  stream: Readable,
  limit: number,
  timeoutMs: number = PUBLISH_CREDENTIAL_HELPER_READ_TIMEOUT_MS,
): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref();
  });
  const read = (async (): Promise<'end' | 'overflow' | 'error'> => {
    try {
      for await (const chunk of stream) {
        const buffer: Buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        total += buffer.length;
        if (total > limit) return 'overflow';
        chunks.push(buffer);
      }
      return 'end';
    } catch {
      return 'error';
    }
  })();
  const outcome = await Promise.race([read, timedOut]);
  if (timer !== undefined) clearTimeout(timer);
  if (outcome !== 'end') {
    stream.destroy();
    return null;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The descriptor is a readable pipe the host process wrote before the spawn.
 * Only a real pipe is accepted: `createReadStream` over a closed or regular-file
 * descriptor can abort the process instead of failing the read, and a helper
 * must always leave with exit 1. `fstat` also keeps an arbitrary inherited fd
 * from being interpreted as a descriptor answer.
 */
function readBoundedDescriptor(fd: number, limit: number): Promise<string | null> {
  let stats: fs.Stats;
  try {
    stats = fs.fstatSync(fd);
  } catch {
    return Promise.resolve(null);
  }
  if (!stats.isFIFO() && !stats.isSocket()) return Promise.resolve(null);
  // `fd` replaces the path argument, so the empty path is never resolved. The
  // stream closes the inherited descriptor when it ends; the process is done
  // with it either way.
  const stream = fs.createReadStream('', { fd, autoClose: true });
  return readBoundedStream(stream, limit);
}
