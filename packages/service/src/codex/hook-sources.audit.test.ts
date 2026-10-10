import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Plan 05.1-32 truth 7: nothing in the hook pipeline touches the Codex home, configuration or
 * credential, runs a process, takes a signal, or adds a timer of its own. hook-status.ts has its
 * own scan; this covers the other four modules. */
const HERE = dirname(fileURLToPath(import.meta.url));

function code(file: string): string {
  return readFileSync(join(HERE, file), "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

const FILES = ["hook-pipeline.ts", "hook-overlay.ts", "hook-routes.ts", "hook-spool.ts"];

describe("hook modules stay out of the Codex home and arm no timer (CODEX-09)", () => {
  it.each(FILES)("%s runs no process, signal or Codex-home read", (file) => {
    const text = code(file);
    expect(text).not.toMatch(/child_process|\bspawn\b|execFile|process\.kill|SIGINT|SIGTERM/);
    expect(text).not.toMatch(/auth\.json|config\.toml|hooks\.json|\.codex\b|CODEX_HOME|codexHome/);
    expect(text).not.toMatch(/node:(http|https|net|dgram)/);
  });

  it.each(["hook-pipeline.ts", "hook-overlay.ts", "hook-routes.ts"])(
    "%s adds no timer of its own",
    (file) => {
      expect(code(file)).not.toMatch(/setInterval|setTimeout|setImmediate/);
    },
  );

  it("the spool reuses the Phase 5 poller and does not copy its algorithm", () => {
    const text = code("hook-spool.ts");
    expect(text).toMatch(/startSpoolPoller/);
    expect(text).not.toMatch(/setInterval|\brename\(/);
  });
});
