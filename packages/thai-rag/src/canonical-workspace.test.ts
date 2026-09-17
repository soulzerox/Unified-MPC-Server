import { describe, expect, it } from 'vitest';
import {
  THAI_RAG_NAMESPACE_LAYOUT_VERSION,
  THAI_RAG_PROVIDER_ID,
  parseCanonicalWorkspaceId,
  resolveThaiRagProviderRoot,
  resolveThaiRagWorkspaceNamespace,
} from './canonical-workspace.js';

const WORKSPACE_A = '0f2e1500-b802-4a1f-8c11-00000000000a';
const WORKSPACE_B = '0f2e1500-b802-4a1f-8c11-00000000000b';
const DATA_ROOT = '/home/alice/.local/share/unified-mpc';
const SAME_BASENAME_ROOT = '/home/alice/Code/repo';

describe('parseCanonicalWorkspaceId', () => {
  it('accepts a canonical lowercase Unified workspace UUID', () => {
    const parsed = parseCanonicalWorkspaceId(WORKSPACE_A);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toBe(WORKSPACE_A);
  });

  it('rejects free-form workspace strings and filesystem basenames', () => {
    expect(parseCanonicalWorkspaceId('Unified MCP Server').ok).toBe(false);
    expect(parseCanonicalWorkspaceId(SAME_BASENAME_ROOT.split('/').pop() ?? '').ok).toBe(false);
    expect(parseCanonicalWorkspaceId('').ok).toBe(false);
  });

  it('rejects paths, uppercase UUIDs, and padded whitespace', () => {
    expect(parseCanonicalWorkspaceId(SAME_BASENAME_ROOT).ok).toBe(false);
    expect(parseCanonicalWorkspaceId(WORKSPACE_A.toUpperCase()).ok).toBe(false);
    expect(parseCanonicalWorkspaceId(` ${WORKSPACE_A} `).ok).toBe(false);
  });
});

describe('resolveThaiRagProviderRoot', () => {
  it('roots native provider state under the Unified-owned data root', () => {
    const root = resolveThaiRagProviderRoot(DATA_ROOT);
    expect(root.ok).toBe(true);
    if (root.ok) {
      expect(root.value).toBe(`${DATA_ROOT}/thai-rag`);
      expect(root.value).not.toContain('.cache');
    }
  });

  it('refuses relative or empty provider data roots', () => {
    expect(resolveThaiRagProviderRoot('relative-data').ok).toBe(false);
    expect(resolveThaiRagProviderRoot('').ok).toBe(false);
  });
});

describe('resolveThaiRagWorkspaceNamespace', () => {
  it('derives the canonical workspace-scoped namespace layout', () => {
    const namespace = resolveThaiRagWorkspaceNamespace(DATA_ROOT, WORKSPACE_A);
    expect(namespace.ok).toBe(true);
    if (!namespace.ok) return;
    const root = `${DATA_ROOT}/thai-rag/workspaces/${WORKSPACE_A}`;
    expect(namespace.value.workspaceId).toBe(WORKSPACE_A);
    expect(namespace.value.root).toBe(root);
    expect(namespace.value.memories).toBe(`${root}/memories.sqlite`);
    expect(namespace.value.codeIndex).toBe(`${root}/code-index`);
    expect(namespace.value.cpg).toBe(`${root}/cpg`);
    expect(namespace.value.vectors).toBe(`${root}/vectors`);
    expect(namespace.value.cache).toBe(`${root}/cache`);
    expect(namespace.value.manifest).toBe(`${root}/manifest.json`);
  });

  it('isolates same-basename repositories by canonical workspace UUID only', () => {
    const a = resolveThaiRagWorkspaceNamespace(DATA_ROOT, WORKSPACE_A);
    const b = resolveThaiRagWorkspaceNamespace(DATA_ROOT, WORKSPACE_B);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.root).not.toBe(b.value.root);
    for (const namespace of [a.value, b.value]) {
      const segments = namespace.root.split('/');
      expect(segments).not.toContain('repo');
      expect(segments).not.toContain('Code');
    }
  });

  it('refuses to address a workspace by basename or path', () => {
    expect(resolveThaiRagWorkspaceNamespace(DATA_ROOT, 'repo').ok).toBe(false);
    expect(resolveThaiRagWorkspaceNamespace(DATA_ROOT, SAME_BASENAME_ROOT).ok).toBe(false);
  });

  it('propagates invalid provider data roots', () => {
    expect(resolveThaiRagWorkspaceNamespace('relative-data', WORKSPACE_A).ok).toBe(false);
  });

  it('exposes the provider identity and namespace layout version', () => {
    expect(THAI_RAG_PROVIDER_ID).toBe('thai-rag');
    expect(THAI_RAG_NAMESPACE_LAYOUT_VERSION).toBe(1);
  });
});
