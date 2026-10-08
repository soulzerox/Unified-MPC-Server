import { randomBytes } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  issueRegisteredThaiRagWorkspaceProof,
  type ThaiRagRegisteredProofRequest,
  type ThaiRagTrustedAuthority,
} from './native-thai-rag-authority-scope.js';

/**
 * Additive authenticated worker-launch payload, matching Python PR #193.
 *
 * The serialized bytes contain a private key. Pass ONLY through a private
 * inherited child-process FD, not env, argv, MCP, HTTP, log or durable config.
 * The current MCP StdioClientTransport does not accept an extra descriptor;
 * no production worker integration or strict-mode cutover occurs here.
 */
export interface ThaiRagWorkerBootstrapOptions {
  readonly ownerId: string;
  readonly authorityGeneration: number;
  readonly workspacesProvider: ThaiRagTrustedAuthority['workspacesProvider'];
}

export interface ThaiRagPrivateWorkerBootstrap {
  /** Sensitive, ephemeral bytes to write into an inherited private FD. */
  readonly payload: Buffer;
  /** Recheck the live registry for every new signed operation. */
  issue(request: ThaiRagRegisteredProofRequest): Promise<string>;
  /** Best-effort zeroization; caller must also close any duplicated FDs. */
  dispose(): void;
}

const MAX_BOOTSTRAP_BYTES = 128 * 1024;
const MAX_WORKSPACES = 1024;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function denied(): never {
  throw new Error('thai_rag_authority_denied');
}

export async function createThaiRagPrivateWorkerBootstrap(
  options: ThaiRagWorkerBootstrapOptions,
): Promise<ThaiRagPrivateWorkerBootstrap> {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(options.ownerId)
    || !Number.isSafeInteger(options.authorityGeneration)
    || options.authorityGeneration < 1
    || typeof options.workspacesProvider !== 'function') {
    denied();
  }

  let roots: readonly { readonly id: string; readonly realRootPath: string }[];
  try {
    roots = await options.workspacesProvider();
    if (!Array.isArray(roots) || roots.length < 1 || roots.length > MAX_WORKSPACES) denied();
    const workspaceRoots: Record<string, string> = Object.create(null) as Record<string, string>;
    const usedPaths = new Set<string>();
    for (const entry of roots) {
      if (!entry || typeof entry.id !== 'string' || !CANONICAL_UUID.test(entry.id)
        || typeof entry.realRootPath !== 'string' || !path.isAbsolute(entry.realRootPath)
        || Object.hasOwn(workspaceRoots, entry.id)) denied();
      const canonical = path.resolve(entry.realRootPath);
      if (canonical === path.parse(canonical).root || canonical !== entry.realRootPath) denied();
      const resolved = await realpath(entry.realRootPath);
      const info = await lstat(entry.realRootPath);
      if (resolved !== canonical || !info.isDirectory() || usedPaths.has(resolved)) denied();
      usedPaths.add(resolved);
      workspaceRoots[entry.id] = canonical;
    }

    const secret = randomBytes(32);
    const payload = Buffer.from(JSON.stringify({
      secret_b64url: secret.toString('base64url'),
      owner_id: options.ownerId,
      authority_generation: options.authorityGeneration,
      workspace_roots: workspaceRoots,
    }), 'utf8');
    if (payload.byteLength > MAX_BOOTSTRAP_BYTES) {
      secret.fill(0);
      payload.fill(0);
      denied();
    }

    let disposed = false;
    const authority: ThaiRagTrustedAuthority = {
      secret,
      ownerId: options.ownerId,
      authorityGeneration: options.authorityGeneration,
      workspacesProvider: options.workspacesProvider,
    };
    return {
      payload,
      async issue(request): Promise<string> {
        if (disposed) denied();
        return issueRegisteredThaiRagWorkspaceProof(authority, request);
      },
      dispose(): void {
        if (disposed) return;
        disposed = true;
        payload.fill(0);
        secret.fill(0);
      },
    };
  } catch {
    denied();
  }
}
