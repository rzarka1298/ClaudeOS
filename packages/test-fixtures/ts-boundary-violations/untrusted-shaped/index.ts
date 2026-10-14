// Layer-2 fixture for the untrusted folder (plan 07-02, task 2). This project is
// shaped like packages/service/src/untrusted/tsconfig.json: composite, `types`
// empty, a reference to the domain project and nothing else. Each statement
// below names one I/O primitive that does not exist when no ambient types are
// loaded, so the compiler must report exactly one diagnostic per line. See
// ../../src/ts-boundary.test.ts, which asserts them. The clean twin
// (../untrusted-shaped-clean) proves the same configuration compiles when only
// a domain type is imported.

import * as fs from "node:fs";
import type { NoteId } from "@ccc/domain";
import { spawn } from "child_process";

export const aDomainType: NoteId | null = null;

export const usesFetch = fetch("https://example.invalid/");
export const usesProcess = process.env.HOME;
export const usesRequire = require("x");
export const usesTimer = setTimeout(() => undefined, 1);
export const usesFs = fs;
export const usesChildProcess = spawn;
