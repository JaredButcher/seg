/**
 * Common-password rejection (planning/07 §2).
 *
 * This is a starter list, not the real one. The plan calls for a bundled top-10k list;
 * swap this for a generated module built from SecLists or the Pwned Passwords top-N at
 * M5, keeping the same interface. Server-side only — shipping 10k passwords to the
 * browser to pre-validate a rare error is not worth the bundle size.
 *
 * Comparison is case-insensitive because "Password1" is no better than "password1".
 */
const COMMON = new Set(
  [
    'password',
    'password1',
    'password12',
    'password123',
    'password1234',
    '1234567890',
    '12345678901',
    '123456789012',
    'qwertyuiop',
    'qwerty12345',
    'letmein123',
    'iloveyou123',
    'welcome123',
    'admin12345',
    'administrator',
    'football123',
    'baseball123',
    'trustno1234',
    'passw0rd123',
    'p@ssw0rd123',
    'changeme123',
    'sunshine123',
    'princess123',
    'superman123',
    'monkey12345',
    'dragon12345',
    'starwars123',
    'whatever123',
    'qazwsxedc123',
    'zaq12wsxcde3',
    'abcd1234567',
    'aaaaaaaaaa',
    '0000000000',
    '1111111111',
    'submarine1',
    'submarine123',
  ].map((p) => p.toLowerCase()),
);

export function isCommonPassword(password: string): boolean {
  return COMMON.has(password.toLowerCase());
}
