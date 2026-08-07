import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from '../src/auth/password.js';

describe('password hashing', () => {
  it('uses argon2id with parameters meeting OWASP guidance', async () => {
    const encoded = await hashPassword('correct horse battery staple');

    // The encoded hash carries its own parameters, so this asserts what was actually used
    // rather than what we believe we configured. See the note in password.ts.
    expect(encoded).toMatch(/^\$argon2id\$/);

    const memory = Number(/\bm=(\d+)/.exec(encoded)?.[1]);
    const iterations = Number(/\bt=(\d+)/.exec(encoded)?.[1]);

    expect(memory).toBeGreaterThanOrEqual(19456); // >= 19 MiB
    expect(iterations).toBeGreaterThanOrEqual(2);
  });

  it('salts each hash, so identical passwords do not collide', async () => {
    const a = await hashPassword('correct horse battery staple');
    const b = await hashPassword('correct horse battery staple');
    expect(a).not.toBe(b);
  });

  it('verifies a correct password and rejects a wrong one', async () => {
    const encoded = await hashPassword('correct horse battery staple');
    await expect(verifyPassword(encoded, 'correct horse battery staple')).resolves.toBe(true);
    await expect(verifyPassword(encoded, 'Correct horse battery staple')).resolves.toBe(false);
  });

  it('returns false rather than throwing for a missing or corrupt hash', async () => {
    await expect(verifyPassword(undefined, 'anything at all')).resolves.toBe(false);
    await expect(verifyPassword('not-a-hash', 'anything at all')).resolves.toBe(false);
  });

  it('spends comparable time on a missing account and a wrong password', async () => {
    const encoded = await hashPassword('correct horse battery staple');

    const time = async (fn: () => Promise<unknown>): Promise<number> => {
      const start = performance.now();
      await fn();
      return performance.now() - start;
    };

    // Warm up, so JIT and the lazily-built dummy hash do not skew the measurement.
    await verifyPassword(encoded, 'wrong');
    await verifyPassword(undefined, 'wrong');

    const withAccount = await time(() => verifyPassword(encoded, 'wrong password entirely'));
    const withoutAccount = await time(() => verifyPassword(undefined, 'wrong password entirely'));

    // A deliberately loose bound: the point is that the no-account path does real work
    // rather than returning instantly, not that timings match precisely. A regression
    // that removed the dummy verify would show a ratio in the hundreds.
    expect(withoutAccount).toBeGreaterThan(withAccount * 0.25);
  });
});
