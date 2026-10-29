import { describe, expect, it } from 'vitest';
import { HEAVY_ADMISSION_CLASSES } from '@unified-mpc/workspace';
import { SHELL_HEAVY_ADMISSION_CLASSES } from '@unified-mpc/capabilities';
import { shellCapabilitySchema } from './schemas.js';

describe('shell admission_class schema (#145)', () => {
  it('keeps the wire vocabulary identical to the classes the queue enforces', () => {
    expect([...SHELL_HEAVY_ADMISSION_CLASSES].sort()).toEqual([...HEAVY_ADMISSION_CLASSES].sort());
  });

  it('accepts a declared heavy class', () => {
    expect(shellCapabilitySchema.parse({ executable: 'pnpm', admission_class: 'verification_heavy' }).admission_class)
      .toBe('verification_heavy');
  });

  it('rejects a class outside the heavy vocabulary', () => {
    expect(shellCapabilitySchema.safeParse({ executable: 'pnpm', admission_class: 'goal_process' }).success).toBe(false);
    expect(shellCapabilitySchema.safeParse({ executable: 'pnpm', admission_class: 'banana' }).success).toBe(false);
  });

  it('keeps the declaration optional', () => {
    expect(shellCapabilitySchema.parse({ executable: 'pnpm' }).admission_class).toBeUndefined();
  });
});
