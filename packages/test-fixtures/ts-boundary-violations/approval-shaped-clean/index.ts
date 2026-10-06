// The clean half of the layer-2 fixture pair: the same project shape, with an
// import-free body. It must compile with no output, which proves the compiler
// run in ts-boundary.test.ts discriminates instead of always failing.
export const selfContained: number = 1;
