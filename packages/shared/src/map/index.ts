/**
 * Map generation — the shared interface and the per-type generators (planning/14).
 *
 * Each map type has its own generator behind a common `MapGenerator` interface fed by the
 * map size parameter; `generateMap` is the entry point the rest of the codebase uses. Empty
 * is open water; Sparse and Dense are carved cave systems built by the pipeline in `caves.ts`.
 *
 * The pipeline's stages are exported individually as well, because the seed gallery and the
 * generator's own tests need to look inside a map rather than only at one.
 */

export * from './carve.js';
export * from './caves.js';
export * from './contours.js';
export * from './empty.js';
export * from './generators.js';
export * from './measure.js';
export * from './registry.js';
export * from './sizes.js';
export * from './skeleton.js';
export * from './tuning.js';
export * from './types.js';
