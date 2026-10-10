// Layer-2 fixture (plan 06-02, task 3). This project is shaped like the real
// nested approval project: composite, a closed file list, no references. It
// imports a sibling file that is NOT in the project's file list, which the
// compiler must reject with TS6307. The sibling exists, so the failure is the
// project boundary, not a missing module. See ../../src/ts-boundary.test.ts.
import { outsideValue } from "./outside.js";

export const reachedOutside: number = outsideValue;
