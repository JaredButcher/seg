/**
 * Lobby join codes — the single source of truth for both sides.
 *
 * The client validates a typed code before sending it; the server enforces the same rule
 * when minting and resolving one. Shared for the same reason the credential rules are
 * (see ../auth/validation.ts): a rule written twice eventually disagrees with itself.
 *
 * Rules come from planning/07 §4: "a short join code (6 chars, unambiguous alphabet, no
 * vowels to avoid accidental words)".
 */

export const JOIN_CODE_LENGTH = 6;

/**
 * No vowels, so a generated code cannot spell something unfortunate.
 *
 * Note what is *absent*: for every pair that looks alike in a technical mono face — 0/O,
 * 1/I/L, 5/S — both members are excluded rather than one being folded onto the other.
 * That is why there is no lookalike-mapping step in `normalizeJoinCode`: a character a
 * player might have mistaken is not valid input either way, so the code is simply wrong
 * and they retype it.
 *
 * 26 symbols over 6 places is ~309 million codes, which is ample for lobbies that live
 * in memory and vanish on restart.
 */
export const JOIN_CODE_ALPHABET = 'BCDFGHJKMNPQRTVWXYZ2346789';

export type JoinCodeProblem =
  'join_code_empty' | 'join_code_wrong_length' | 'join_code_invalid_characters';

const JOIN_CODE_PATTERN = new RegExp(`^[${JOIN_CODE_ALPHABET}]+$`);

/**
 * Turns what a player typed into the canonical form.
 *
 * Players paste codes out of chat with spaces and hyphens in them, and type them in
 * lowercase. All of that is the same code, and rejecting it would be a self-inflicted
 * support problem — so separators are stripped and the result is upper-cased before any
 * rule is applied.
 */
export function normalizeJoinCode(input: string): string {
  return input.replace(/[\s-]+/g, '').toUpperCase();
}

/** Validates an already-normalized code. Returns `null` when it is well-formed. */
export function validateJoinCode(code: string): JoinCodeProblem | null {
  if (code.length === 0) return 'join_code_empty';
  if (code.length !== JOIN_CODE_LENGTH) return 'join_code_wrong_length';
  if (!JOIN_CODE_PATTERN.test(code)) return 'join_code_invalid_characters';
  return null;
}

/** Human-readable text for a join-code problem. Shown by the client, sent by the server. */
export function describeJoinCodeProblem(problem: JoinCodeProblem): string {
  switch (problem) {
    case 'join_code_empty':
      return 'Enter the code the host gave you.';
    case 'join_code_wrong_length':
      return `A join code is ${JOIN_CODE_LENGTH} characters.`;
    case 'join_code_invalid_characters':
      // Naming the excluded characters is more useful than naming the permitted ones:
      // a player who typed an O meant a Q or a 0, and neither is in the alphabet.
      return 'That is not a valid code. Join codes never contain vowels, or the characters 0, 1, 5, I, L, O, or S.';
  }
}
