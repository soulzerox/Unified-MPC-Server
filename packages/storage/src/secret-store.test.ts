import { describe, expect, it } from 'vitest';
import { SecretToolSecretStore } from './secret-store.js';

describe('SecretToolSecretStore', () => {
  it('uses Secret Service command arguments and never persists a file', async () => {
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    const values = new Map<string, string>();
    const store = new SecretToolSecretStore({
      service: 'test-service',
      run: async (args, input): Promise<string> => {
        calls.push({ args, ...(input === undefined ? {} : { input }) });
        const operation = args[0];
        const key = args.at(-1)!;
        if (operation === 'store') {
          values.set(key, input!);
          return '';
        }
        if (operation === 'lookup') return values.get(key) ?? '';
        values.delete(key);
        return '';
      },
    });

    await store.set('tunnel_token', 'secret-value');
    await expect(store.get('tunnel_token')).resolves.toBe('secret-value');
    await store.delete('tunnel_token');
    await expect(store.get('tunnel_token')).resolves.toBeNull();
    expect(calls[0]).toEqual({
      args: ['store', '--label', 'Unified-MPC-Server secret', 'service', 'test-service', 'key', 'tunnel_token'],
      input: 'secret-value',
    });
    expect(calls.some(({ args }) => args.includes('secret-value'))).toBe(false);
  });

  it('rejects unsafe secret keys and empty values', async () => {
    const store = new SecretToolSecretStore({ run: async (): Promise<string> => '' });
    await expect(store.set('bad key', 'value')).rejects.toThrow(/invalid/i);
    await expect(store.set('valid', ' ')).rejects.toThrow(/empty/i);
  });

  it('treats secret-tool exit code 1 as missing secret, not lookup failure', async () => {
    const notFound = Object.assign(new Error('secret-tool exited with code 1'), { secretToolExitCode: 1 });
    const store = new SecretToolSecretStore({
      run: async (args): Promise<string> => {
        if (args[0] === 'lookup' || args[0] === 'clear') throw notFound;
        return '';
      },
    });
    await expect(store.get('cloudflare_api_token')).resolves.toBeNull();
    await expect(store.delete('cloudflare_api_token')).resolves.toBeUndefined();

    const otherFailure = Object.assign(new Error('secret-tool exited with code 2'), { secretToolExitCode: 2 });
    const failing = new SecretToolSecretStore({
      run: async (): Promise<string> => {
        throw otherFailure;
      },
    });
    await expect(failing.get('any_key')).rejects.toThrow(/lookup failed/);
  });

  it('separates a locked collection from a missing daemon and a timeout (#297)', async () => {
    const locked = Object.assign(new Error('Cannot create an item in a locked collection'), { secretToolExitCode: 2 });
    const lockedStore = new SecretToolSecretStore({
      run: async (): Promise<string> => {
        throw locked;
      },
    });
    await expect(lockedStore.set('token', 'value')).rejects.toMatchObject({ reason: 'secret-store-locked' });
    await expect(lockedStore.set('token', 'value')).rejects.toThrow(/locked/);

    const missing = Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' });
    const missingStore = new SecretToolSecretStore({
      run: async (): Promise<string> => {
        throw missing;
      },
    });
    await expect(missingStore.get('token')).rejects.toMatchObject({ reason: 'secret-store-missing' });

    const timedOut = new Error('secret-tool timed out');
    const timeoutStore = new SecretToolSecretStore({
      run: async (): Promise<string> => {
        throw timedOut;
      },
    });
    await expect(timeoutStore.set('token', 'value')).rejects.toMatchObject({ reason: 'secret-store-timeout' });
  });

  it('does not read a locked collection as an absent secret on lookup or clear (#297)', async () => {
    // `secret-tool` uses exit code 1 for "no such item" and for a locked
    // collection alike, so exit code alone must not decide.
    const locked = Object.assign(new Error('Cannot create an item in a locked collection'), { secretToolExitCode: 1 });
    const store = new SecretToolSecretStore({
      run: async (): Promise<string> => {
        throw locked;
      },
    });
    await expect(store.get('token')).rejects.toMatchObject({ reason: 'secret-store-locked' });
    await expect(store.delete('token')).rejects.toMatchObject({ reason: 'secret-store-locked' });

    const absent = Object.assign(new Error('secret-tool exited with code 1'), { secretToolExitCode: 1 });
    const emptyStore = new SecretToolSecretStore({
      run: async (): Promise<string> => {
        throw absent;
      },
    });
    await expect(emptyStore.get('token')).resolves.toBeNull();
    await expect(emptyStore.delete('token')).resolves.toBeUndefined();
  });
});