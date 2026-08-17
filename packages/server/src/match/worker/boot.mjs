/**
 * @seg/server/match/worker/boot — the four lines that let a worker thread load TypeScript.
 *
 * `.mjs`, and the only file in the server that is not `.ts`. That is the whole point of it.
 *
 * ## Why this exists
 *
 * The server runs from source under `tsx` — there is no build step, because `@seg/shared` is
 * consumed as TypeScript by both the client and the server (planning/01 §2, `deploy/Dockerfile`).
 * `tsx` installs an ESM loader hook, and **module hooks are per-thread**: a `new Worker(...)`
 * pointed at a `.ts` file from inside a tsx-loaded process dies with
 * `ERR_UNKNOWN_FILE_EXTENSION` before a line of it runs.
 *
 * The obvious fix does not work either. `new Worker(url, { execArgv: ['--import', 'tsx'] })` is
 * accepted without complaint and has no effect — `execArgv` supports only a subset of the Node CLI
 * options, and `--import` is not in it. It fails exactly as if nothing had been passed, which is
 * the worst way for it to fail, so: **do not "simplify" this file into an execArgv option.** It
 * has been tried.
 *
 * What does work is registering the hook from inside the worker, which means the worker's entry
 * point has to be something Node can already load. Hence a `.mjs` shim whose only job is to turn
 * the loader on and then hand over to `entry.ts`.
 *
 * `tsx` resolves from `packages/server/node_modules` in both dev and the production image, because
 * this file lives under `packages/server` and that is where pnpm's isolated layout puts it.
 */

import { register } from 'tsx/esm/api';

register();

await import(new URL('./entry.ts', import.meta.url).href);
