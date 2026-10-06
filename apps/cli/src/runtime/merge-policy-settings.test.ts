import { describe, expect, it } from 'vitest';
import { parseRepositoryMergePolicySetting } from './merge-policy-settings.js';

describe('parseRepositoryMergePolicySetting', () => {
  it('returns one exact configured policy by case-insensitive repository identity', () => {
    const value = JSON.stringify([
      {
        repository: 'soulzerox/Unified-MPC-Server',
        defaultBranch: 'main',
        verificationMode: 'hybrid',
        requiredGates: [
          { name: 'test', source: 'local_command' },
          { name: 'runtime release portability gate', source: 'github_check' },
        ],
        reviewPolicy: {
          required: true,
          acceptedOutcomes: ['clean_llm_review', 'github_approved'],
        },
      },
    ]);

    expect(parseRepositoryMergePolicySetting(value, 'SOULZEROX/unified-mpc-server')).toEqual({
      repository: 'soulzerox/Unified-MPC-Server',
      defaultBranch: 'main',
      verificationMode: 'hybrid',
      requiredGates: [
        { name: 'test', source: 'local_command' },
        { name: 'runtime release portability gate', source: 'github_check' },
      ],
      reviewPolicy: {
        required: true,
        acceptedOutcomes: ['clean_llm_review', 'github_approved'],
      },
    });
  });

  it.each([
    null,
    '',
    '{}',
    JSON.stringify([{ repository: 'owner/repo', defaultBranch: '', verificationMode: 'github_ci', requiredGates: [], reviewPolicy: { required: true, acceptedOutcomes: ['github_approved'] } }]),
    JSON.stringify([{ repository: 'owner/repo', defaultBranch: 'main', verificationMode: 'unknown', requiredGates: [], reviewPolicy: { required: true, acceptedOutcomes: ['github_approved'] } }]),
    JSON.stringify([{ repository: 'owner/repo', defaultBranch: 'main', verificationMode: 'github_ci', requiredGates: [{ name: 'ci', source: 'bogus' }], reviewPolicy: { required: true, acceptedOutcomes: ['github_approved'] } }]),
    JSON.stringify([{ repository: 'owner/repo', defaultBranch: 'main', verificationMode: 'github_ci', requiredGates: [], reviewPolicy: { required: true, acceptedOutcomes: [] } }]),
  ])('fails closed for absent or malformed policy setting %#', (value) => {
    expect(parseRepositoryMergePolicySetting(value, 'owner/repo')).toBeUndefined();
  });

  it('fails closed when multiple policies normalize to the same repository', () => {
    const value = JSON.stringify([
      {
        repository: 'Owner/Repo',
        defaultBranch: 'main',
        verificationMode: 'github_ci',
        requiredGates: [{ name: 'ci', source: 'github_check' }],
        reviewPolicy: { required: true, acceptedOutcomes: ['github_approved'] },
      },
      {
        repository: 'owner/repo',
        defaultBranch: 'main',
        verificationMode: 'local_exact_head',
        requiredGates: [{ name: 'test', source: 'local_command' }],
        reviewPolicy: { required: true, acceptedOutcomes: ['clean_llm_review'] },
      },
    ]);

    expect(parseRepositoryMergePolicySetting(value, 'owner/repo')).toBeUndefined();
  });
});
