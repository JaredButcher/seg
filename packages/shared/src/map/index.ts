/**
 * Map generation — the shared interface and the per-type generators (planning/14).
 *
 * Each map type has its own generator behind a common `MapGenerator` interface fed by the
 * map size parameter; `generateMap` is the entry point the rest of the codebase uses. Only
 * the Empty generator is implemented so far.
 */

export * from './empty.js';
export * from './generators.js';
export * from './registry.js';
export * from './sizes.js';
export * from './types.js';
