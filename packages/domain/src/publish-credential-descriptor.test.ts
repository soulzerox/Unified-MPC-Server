import { describe, expect, it } from 'vitest';
import {
  formatPublishCredentialBlock,
  normalizePublishCredentialPromptHost,
  parsePublishCredentialDescriptorAnswer,
  parsePublishCredentialDescriptorFd,
  parsePublishCredentialPrompt,
  serializePublishCredentialDescriptorAnswer,
  type PublishCredentialDescriptorAnswer,
} from './publish-credential-descriptor.js';

function answer(overrides: Partial<PublishCredentialDescriptorAnswer> = {}): PublishCredentialDescriptorAnswer {
  return {
    version: 1,
    leaseId: 'lease-1',
    username: 'x-access-token',
    secret: 's3cret-value',
    hosts: ['github.com'],
    expiresAt: 2_000,
    ...overrides,
  };
}

describe('publish credential prompt parsing', () => {
  it('reads the attributes Git writes for one get', () => {
    expect(parsePublishCredentialPrompt('protocol=https\nhost=GitHub.com\npath=soulzerox/repo.git\n\n')).toEqual({
      protocol: 'https',
      host: 'GitHub.com',
      path: 'soulzerox/repo.git',
    });
  });

  it('accepts a prompt without path and without a trailing blank line', () => {
    expect(parsePublishCredentialPrompt('protocol=https\nhost=github.com')).toEqual({
      protocol: 'https',
      host: 'github.com',
      path: null,
    });
  });

  it('stops at the first blank line so a later block cannot change the answer', () => {
    expect(parsePublishCredentialPrompt('protocol=https\nhost=github.com\n\nhost=gitlab.com\n')).toEqual({
      protocol: 'https',
      host: 'github.com',
      path: null,
    });
  });

  it('ignores unknown attributes and keeps the first occurrence of a key', () => {
    expect(parsePublishCredentialPrompt(
      'username=ignored\nprotocol=https\nhost=github.com\nhost=gitlab.com\nwwwauth[]=basic\n',
    )).toEqual({ protocol: 'https', host: 'github.com', path: null });
  });

  it('refuses a prompt without protocol or without host', () => {
    expect(parsePublishCredentialPrompt('host=github.com\n')).toBeNull();
    expect(parsePublishCredentialPrompt('protocol=https\n')).toBeNull();
    expect(parsePublishCredentialPrompt('')).toBeNull();
    expect(parsePublishCredentialPrompt('=https\n')).toBeNull();
  });

  it('refuses a prompt larger than the helper will read', () => {
    expect(parsePublishCredentialPrompt(`protocol=https\nhost=github.com\npath=${'a'.repeat(70_000)}`)).toBeNull();
  });
});

describe('publish credential prompt host normalization', () => {
  it('lowercases and drops the default HTTPS port', () => {
    expect(normalizePublishCredentialPromptHost('GitHub.com')).toBe('github.com');
    expect(normalizePublishCredentialPromptHost(' github.com:443 ')).toBe('github.com');
  });

  it('keeps a non-default port so it must match the lease exactly', () => {
    expect(normalizePublishCredentialPromptHost('github.example.com:8443')).toBe('github.example.com:8443');
    expect(normalizePublishCredentialPromptHost('github.example.com:443')).toBe('github.example.com');
  });

  it('refuses bracketed IPv6, empty labels, out-of-range ports and a bare port', () => {
    expect(normalizePublishCredentialPromptHost('[::1]:443')).toBeNull();
    expect(normalizePublishCredentialPromptHost('github..com')).toBeNull();
    expect(normalizePublishCredentialPromptHost('github.com:0')).toBeNull();
    expect(normalizePublishCredentialPromptHost('github.com:70000')).toBeNull();
    expect(normalizePublishCredentialPromptHost(':443')).toBeNull();
    expect(normalizePublishCredentialPromptHost('')).toBeNull();
    expect(normalizePublishCredentialPromptHost(undefined)).toBeNull();
  });
});

describe('publish credential descriptor fd', () => {
  it('accepts a non-stdio descriptor number', () => {
    expect(parsePublishCredentialDescriptorFd('3')).toBe(3);
    expect(parsePublishCredentialDescriptorFd(' 17 ')).toBe(17);
  });

  it('refuses stdio, zero, negative and non-numeric values', () => {
    expect(parsePublishCredentialDescriptorFd('0')).toBeNull();
    expect(parsePublishCredentialDescriptorFd('2')).toBeNull();
    expect(parsePublishCredentialDescriptorFd('-3')).toBeNull();
    expect(parsePublishCredentialDescriptorFd('three')).toBeNull();
    expect(parsePublishCredentialDescriptorFd(undefined)).toBeNull();
  });
});

describe('publish credential descriptor answer', () => {
  it('round-trips one answer', () => {
    const serialized = serializePublishCredentialDescriptorAnswer(answer());
    expect(serialized.endsWith('\n')).toBe(true);
    expect(parsePublishCredentialDescriptorAnswer(serialized)).toEqual(answer());
  });

  it('refuses an answer with a wrong version, lease id or host list', () => {
    const valid = answer();
    expect(parsePublishCredentialDescriptorAnswer(JSON.stringify({ ...valid, version: 2 }))).toBeNull();
    expect(parsePublishCredentialDescriptorAnswer(JSON.stringify({ ...valid, leaseId: 'bad id' }))).toBeNull();
    expect(parsePublishCredentialDescriptorAnswer(JSON.stringify({ ...valid, hosts: [] }))).toBeNull();
    expect(parsePublishCredentialDescriptorAnswer(JSON.stringify({ ...valid, hosts: ['GitHub.com'] }))).toBeNull();
    expect(parsePublishCredentialDescriptorAnswer(JSON.stringify({ ...valid, hosts: ['github.com', 'github.com'] }))).toBeNull();
  });

  it('refuses a username or secret that could forge an attribute line', () => {
    const valid = answer();
    expect(parsePublishCredentialDescriptorAnswer(JSON.stringify({ ...valid, username: 'git\npassword=x' }))).toBeNull();
    expect(parsePublishCredentialDescriptorAnswer(JSON.stringify({ ...valid, secret: 'a\nb' }))).toBeNull();
    expect(parsePublishCredentialDescriptorAnswer(JSON.stringify({ ...valid, secret: '   ' }))).toBeNull();
    expect(parsePublishCredentialDescriptorAnswer(JSON.stringify({ ...valid, expiresAt: 1.5 }))).toBeNull();
  });

  it('refuses anything that is not one JSON object', () => {
    expect(parsePublishCredentialDescriptorAnswer('')).toBeNull();
    expect(parsePublishCredentialDescriptorAnswer('null')).toBeNull();
    expect(parsePublishCredentialDescriptorAnswer('[]')).toBeNull();
    expect(parsePublishCredentialDescriptorAnswer('{"version":1}')).toBeNull();
    expect(parsePublishCredentialDescriptorAnswer('not json')).toBeNull();
    expect(parsePublishCredentialDescriptorAnswer('x'.repeat(70_000))).toBeNull();
  });
});

describe('publish credential block', () => {
  it('prints the two attributes Git reads and nothing else', () => {
    expect(formatPublishCredentialBlock('git', 's3cret')).toBe('username=git\npassword=s3cret\n');
  });

  it('refuses values that would add or split an attribute line', () => {
    expect(formatPublishCredentialBlock('git\n', 's3cret')).toBeNull();
    expect(formatPublishCredentialBlock('git', 's3cret\nhost=evil.example')).toBeNull();
    expect(formatPublishCredentialBlock('', 's3cret')).toBeNull();
    expect(formatPublishCredentialBlock('git', '')).toBeNull();
  });
});
