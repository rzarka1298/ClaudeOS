// Public entry of the approval engine (APPR-01, D-01, D-03).
//
// Element: `approval` (eslint.config.mjs). Import rule: this folder may import
// `@ccc/domain` and its own `./mint/` folder, nothing else. Every other service
// file may import ONLY this file (`index.ts`), never a deeper approval file.
// A relative import out of this folder also fails the compiler: the folder is
// its own composite project (./tsconfig.json) that references only the domain
// package. Later plans add exports here; this is the engine's one door.
export {};
