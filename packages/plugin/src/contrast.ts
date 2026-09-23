/**
 * RED skeleton — signatures only, no behaviour yet.
 *
 * The contract lives in contrast.test.ts; this file exists so that file can
 * import it and fail on its assertions rather than on a module-resolution
 * error (a load crash proves nothing about the behaviour under test).
 * Replaced with the real implementation in the GREEN commit.
 */

const NOT_IMPLEMENTED = "contrast: not implemented yet (RED)";

export function relativeLuminance(_color: string): number {
  throw new Error(NOT_IMPLEMENTED);
}

export function contrastRatio(_a: string, _b: string): number {
  throw new Error(NOT_IMPLEMENTED);
}
