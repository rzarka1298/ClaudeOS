import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * Audit (wave-3 review): the plugin's runtime import graph has no cycle.
 * A cycle makes module-evaluation order decide whether a binding exists yet
 * (`connection-state → service-event-router → projects-state →
 * connection-state` was one), so it is refused structurally rather than
 * left to happen to work. Type-only imports are erased at build time and
 * cannot cycle at runtime, so they are ignored.
 */

const SRC = dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test-support" ? [] : sourceFiles(path);
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name) || name.endsWith(".d.ts")) return [];
    return [path];
  });
}

/** Relative specifiers this file imports at runtime (not `import type` / `export type`). */
function runtimeImports(file: string): string[] {
  const code = readFileSync(file, "utf8");
  const specs: string[] = [];
  const pattern = /^\s*(import|export)\s+(type\s+)?([^;]*?)\s+from\s+["'](\.[^"']+)["']/gms;
  for (const match of code.matchAll(pattern)) {
    if (match[2] !== undefined) continue;
    const clause = match[3] ?? "";
    // `import { type A, type B } from` is erased too.
    const braced = /^\{([^}]*)\}$/.exec(clause.trim());
    if (braced) {
      const names = (braced[1] ?? "")
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean);
      if (names.length > 0 && names.every((n) => n.startsWith("type "))) continue;
    }
    specs.push(match[4] ?? "");
  }
  for (const match of code.matchAll(/^\s*import\s+["'](\.[^"']+)["']/gm))
    specs.push(match[1] ?? "");
  return specs;
}

function resolveSpec(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec).replace(/\.js$/, "");
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next extension
    }
  }
  return null;
}

function findCycles(files: readonly string[]): string[][] {
  const graph = new Map<string, string[]>();
  for (const file of files) {
    graph.set(
      file,
      runtimeImports(file)
        .map((spec) => resolveSpec(file, spec))
        .filter((target): target is string => target !== null),
    );
  }
  const cycles: string[][] = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (node: string): void => {
    state.set(node, "visiting");
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (state.get(next) === "visiting") {
        cycles.push([...stack.slice(stack.indexOf(next)), next].map((f) => relative(SRC, f)));
      } else if (state.get(next) === undefined) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, "done");
  };
  for (const file of files) if (state.get(file) === undefined) visit(file);
  return cycles;
}

describe("plugin runtime import graph (wave-3 review)", () => {
  it("has no import cycle", () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(20);
    expect(findCycles(files)).toEqual([]);
  });
});
