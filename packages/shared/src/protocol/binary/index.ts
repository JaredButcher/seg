/**
 * @seg/shared/protocol/binary — the binary codec (planning/02 §9 step 3).
 *
 * `BinaryCodec` is the entry point; everything else is exported because the schema is a value that
 * tests, fuzzers and future versions need to walk (`types.ts`).
 */

export * from './codec.js';
export * from './messages.js';
export * from './types.js';
export * from './walk.js';
export * from './wire.js';
