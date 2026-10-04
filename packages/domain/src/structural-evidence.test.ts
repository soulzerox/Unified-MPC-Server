import { describe, expect, it } from 'vitest';
import {
  structuralEdgeEvidenceId,
  structuralSymbolEvidenceId,
  type StructuralEdgeEvidenceIdentityInput,
} from './structural-evidence.js';

describe('shared structural evidence identity', () => {
  it('matches the cross-repo v1 symbol identity fixture', () => {
    expect(structuralSymbolEvidenceId({
      sourceFileId: 'file:repo-1:abc123',
      extractorId: 'python-ast',
      extractorVersion: '1',
      symbolKind: 'method',
      qualifiedName: 'Service.run',
      lineStart: 10,
      lineEnd: 20,
    })).toBe('sym:v1:6646731b5aa671338465f2b9137c67a7de21b889a01bbbb0165576d6816dc6f4');
  });

  it('is source-authority driven rather than workspace/path driven', () => {
    const base = {
      sourceFileId: 'file:repo-1:abc123',
      extractorId: 'python-ast',
      extractorVersion: '1',
      symbolKind: 'method',
      qualifiedName: 'Service.run',
      lineStart: 10,
      lineEnd: 20,
    } as const;
    expect(structuralSymbolEvidenceId(base)).not.toBe(
      structuralSymbolEvidenceId({ ...base, sourceFileId: 'file:repo-1:def456' }),
    );
  });

  it('keeps resolved, heuristic and unresolved edge evidence distinct', () => {
    const base: Omit<StructuralEdgeEvidenceIdentityInput, 'resolution'> = {
      sourceSymbolId: 'sym:v1:source',
      edgeKind: 'calls',
      targetRef: 'Service.save',
      extractorId: 'python-ast',
      extractorVersion: '1',
    };
    const resolved = structuralEdgeEvidenceId({ ...base, resolution: 'resolved' });
    const heuristic = structuralEdgeEvidenceId({ ...base, resolution: 'heuristic' });
    const unresolved = structuralEdgeEvidenceId({ ...base, resolution: 'unresolved' });

    expect(new Set([resolved, heuristic, unresolved]).size).toBe(3);
    expect(resolved).toMatch(/^edge:v1:[0-9a-f]{64}$/);
    expect(structuralEdgeEvidenceId({
      ...base,
      resolution: 'resolved',
      targetRef: 'sym:v1:target',
    })).toBe('edge:v1:1d1b61aea904f65e1065fef2dcb584d380b77a8f1d43bd0604c7c00a3ca1bc44');
  });
});
