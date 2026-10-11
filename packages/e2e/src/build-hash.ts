import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** The plugin files a build hash covers, in the fixed order they are hashed. */
export const BUILD_FILES = ["main.js", "manifest.json", "styles.css"] as const;

function readBuildFile(dir: string, name: string): Buffer {
  const path = join(dir, name);
  try {
    if (!statSync(path).isFile()) throw new Error("not a file");
    return readFileSync(path);
  } catch {
    throw new Error(`The plugin build folder is missing ${name}.`);
  }
}

/** First twelve hex characters of the SHA-256 over main.js, manifest.json and styles.css (D-10). */
export function buildHash(dir: string): string {
  const hash = createHash("sha256");
  for (const name of BUILD_FILES) hash.update(readBuildFile(dir, name));
  return hash.digest("hex").slice(0, 12);
}
