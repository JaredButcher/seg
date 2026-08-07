import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing.
 *
 * @node-rs/argon2 defaults to argon2id at m=19456 KiB, t=2, p=1, which meets current OWASP
 * guidance. The options are left at their defaults deliberately: the package exports
 * `Algorithm` as an ambient const enum, which `verbatimModuleSyntax` cannot import, and
 * hardcoding the numeric value would be a silent lie if the enum ever changed.
 *
 * The algorithm is therefore *asserted* rather than declared — `password.test.ts` checks
 * that produced hashes carry the `$argon2id$` prefix and the expected parameters. A test
 * that inspects the real output is a stronger guarantee than a constant anyway.
 *
 * Raising the cost parameters later requires a rehash-on-login path, or old hashes stop
 * verifying. Do not change them without one.
 */

/**
 * A real hash of a value nobody knows, verified against when the username does not exist.
 *
 * Without it, "unknown username" returns in microseconds while "wrong password" takes
 * ~50 ms, and that gap is a username oracle. Built once at startup.
 */
let dummyHash: string | undefined;

export async function initPasswordHashing(): Promise<void> {
  dummyHash ??= await hash('seg-timing-equalizer-not-a-real-password');
}

export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

/**
 * Verifies a password, doing the same work whether or not the account exists.
 * Pass `undefined` when there is no account for the submitted username.
 */
export async function verifyPassword(
  storedHash: string | undefined,
  password: string,
): Promise<boolean> {
  if (storedHash === undefined) {
    await initPasswordHashing();
    // Result deliberately discarded — this exists only to burn equivalent CPU.
    await verify(dummyHash!, password).catch(() => false);
    return false;
  }

  try {
    return await verify(storedHash, password);
  } catch {
    // A malformed stored hash is a corrupt row, not a successful login.
    return false;
  }
}
