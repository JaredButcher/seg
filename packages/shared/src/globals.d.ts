/**
 * Ambient declarations for the two Web Platform globals that @seg/shared may use.
 *
 * `TextEncoder`/`TextDecoder` are provided by Node (v11+, as globals) and by every
 * browser, so using them does not break the "runs identically in both runtimes" rule
 * (planning/10 §3). They are declared here explicitly rather than by enabling the DOM
 * lib or @types/node in this package's tsconfig — either would silently re-open the
 * whole API boundary that the tsconfig exists to enforce.
 */

interface TextEncoder {
  readonly encoding: string;
  encode(input?: string): Uint8Array;
  encodeInto(source: string, destination: Uint8Array): { read: number; written: number };
}

declare const TextEncoder: {
  new (): TextEncoder;
  prototype: TextEncoder;
};

interface TextDecoder {
  readonly encoding: string;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  decode(input?: Uint8Array | ArrayBuffer): string;
}

declare const TextDecoder: {
  new (label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }): TextDecoder;
  prototype: TextDecoder;
};
