import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Wave 3 audit (06-07 truth 1): the executors folder imports only the domain
 * package (plus zod and its own files); no Node built-in and no other package.
 */
const DIR = import.meta.dirname;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") out.push(...sources(p));
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

const FILES = sources(DIR).filter((f) => !f.includes("/test-support/"));

describe("the executors folder import surface", () => {
  it("has production sources to check", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(3);
  });

  it.each(FILES.map((f) => [f.slice(DIR.length + 1), f] as const))(
    "%s imports only the domain, zod or a relative file",
    (_name, file) => {
      const text = readFileSync(file, "utf8");
      const specs = [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(
        (m) => m[1] as string,
      );
      for (const s of specs) {
        expect(
          s === "@ccc/domain" || s === "zod" || s.startsWith("./") || s.startsWith("../"),
        ).toBe(true);
      }
    },
  );
});
