import { describe, expect, it } from 'vitest';

import { CapabilityRegistry } from './capability-registry.js';
import {
  CODE_INTELLIGENCE_CAPABILITY_ID,
  CODE_INTELLIGENCE_MANIFEST,
  CODE_INTELLIGENCE_PROVIDES,
  registerCodeIntelligenceCapability,
} from './code-intelligence-capability.js';

describe('code intelligence capability lane', () => {
  it('registers its evidence dependency first, then an in-process on-demand lane', async () => {
    const registry = new CapabilityRegistry();

    const registered = await registerCodeIntelligenceCapability(registry);
    if (!registered.ok) throw new Error(registered.error.message);

    expect(registered.value).toMatchObject({
      id: CODE_INTELLIGENCE_CAPABILITY_ID,
      runtimeKind: 'in-process',
      activation: 'on-demand',
      costClass: 'small',
      requires: ['shared-evidence'],
      provides: [...CODE_INTELLIGENCE_PROVIDES],
      generationFenced: false,
    });
  });

  it('registers once and treats a repeated registration as already done', async () => {
    const registry = new CapabilityRegistry();

    const first = await registerCodeIntelligenceCapability(registry);
    if (!first.ok) throw new Error(first.error.message);
    const second = await registerCodeIntelligenceCapability(registry);

    // The lane is already registered, so the second call reports the conflict it
    // actually is rather than pretending to have created a second lane.
    expect(second).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });

  it('counts leases like any other capability, so one caller cannot end the lane for another', async () => {
    const registry = new CapabilityRegistry({ start: async (): Promise<{ ok: true; value: undefined }> => ({ ok: true, value: undefined }) });
    const registered = await registerCodeIntelligenceCapability(registry);
    if (!registered.ok) throw new Error(registered.error.message);

    const first = await registry.acquire(CODE_INTELLIGENCE_CAPABILITY_ID);
    const second = await registry.acquire(CODE_INTELLIGENCE_CAPABILITY_ID);
    if (!first.ok || !second.ok) throw new Error('expected both acquires to succeed');

    expect(registry.health(CODE_INTELLIGENCE_CAPABILITY_ID)?.leaseCount).toBe(2);
    first.value.release();
    expect(registry.health(CODE_INTELLIGENCE_CAPABILITY_ID)?.leaseCount).toBe(1);
    second.value.release();
    expect(registry.health(CODE_INTELLIGENCE_CAPABILITY_ID)?.leaseCount).toBe(0);
  });

  it('declares no startup or shutdown timeout, because nothing starts', () => {
    // A timeout for work that cannot happen would be a promise the lane cannot keep.
    expect(CODE_INTELLIGENCE_MANIFEST.startupTimeoutMs).toBeUndefined();
    expect(CODE_INTELLIGENCE_MANIFEST.shutdownTimeoutMs).toBeUndefined();
    expect(CODE_INTELLIGENCE_MANIFEST.recyclable).toBe(true);
  });
});
