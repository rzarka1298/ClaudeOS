import { describe, expect, it } from "vitest";
import { CD_FAILED_MESSAGE, renderLaunchScript } from "./launch-script.js";
import { UnsafeScriptArgumentError } from "./sh-quote.js";

const CWD = "/Users/USERNAME/code/example-project";

function linesOf(script: string): string[] {
  return script.split("\n");
}

describe("renderLaunchScript (D-17, D-20)", () => {
  const script = renderLaunchScript({
    cwd: CWD,
    argv: ["/opt/homebrew/bin/claude", "--resume", "it's"],
    env: { FIRST_KEY: "one", SECOND: "two words" },
  });
  const lines = linesOf(script);

  it("starts with the /bin/sh shebang", () => {
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
  });

  it("removes itself ($0) on the second line, before anything else runs", () => {
    expect(lines[1]).toBe('rm -f -- "$0"');
  });

  it("exports one single-quoted line per env entry", () => {
    expect(lines).toContain("export FIRST_KEY='one'");
    expect(lines).toContain("export SECOND='two words'");
  });

  it("changes into the quoted cwd or prints the fixed folder message and exits 1", () => {
    const cdLine = lines.find((l) => l.startsWith("cd -- "));
    expect(cdLine).toBeDefined();
    expect(cdLine).toContain(`cd -- '${CWD}' || {`);
    expect(cdLine).toContain(CD_FAILED_MESSAGE);
    expect(cdLine).toContain("exit 1;");
  });

  it("the folder message is a constant and never contains the path", () => {
    expect(CD_FAILED_MESSAGE).not.toContain("/");
  });

  it("runs the argv as one line of single-quoted words", () => {
    expect(lines).toContain("'/opt/homebrew/bin/claude' '--resume' 'it'\\''s'");
  });

  it("ends by exec-ing the owner's login shell so the window stays useful", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the expected text is a literal shell parameter expansion.
    expect(script.endsWith('exec "${SHELL:-/bin/zsh}" -l\n')).toBe(true);
  });

  it("orders shebang, self-delete, exports, cd, argv, exec", () => {
    const idx = (pred: (l: string) => boolean) => lines.findIndex(pred);
    const exportIdx = idx((l) => l.startsWith("export "));
    const cdIdx = idx((l) => l.startsWith("cd -- "));
    const argvIdx = idx((l) => l.startsWith("'/opt/homebrew/bin/claude'"));
    const execIdx = idx((l) => l.startsWith("exec "));
    expect(exportIdx).toBeGreaterThan(1);
    expect(cdIdx).toBeGreaterThan(exportIdx);
    expect(argvIdx).toBeGreaterThan(cdIdx);
    expect(execIdx).toBeGreaterThan(argvIdx);
  });

  it("renders no export line when env is omitted", () => {
    const bare = renderLaunchScript({ cwd: CWD, argv: ["/usr/bin/true"] });
    expect(bare.startsWith("#!/bin/sh\n")).toBe(true);
    expect(linesOf(bare).some((l) => l.startsWith("export "))).toBe(false);
  });

  it("refuses an env key outside ^[A-Z_][A-Z0-9_]*$ with reason env-key", () => {
    for (const key of ["lower", "1ABC", "A-B", "A B", "A;touch", ""]) {
      let caught: unknown;
      try {
        renderLaunchScript({ cwd: CWD, argv: ["/usr/bin/true"], env: { [key]: "v" } });
      } catch (err: unknown) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(UnsafeScriptArgumentError);
      expect((caught as UnsafeScriptArgumentError).reason).toBe("env-key");
    }
  });

  it("refuses a line break in the cwd, an argv element or an env value", () => {
    expect(() => renderLaunchScript({ cwd: "/tmp/a\nb", argv: ["/usr/bin/true"] })).toThrow(
      UnsafeScriptArgumentError,
    );
    expect(() => renderLaunchScript({ cwd: CWD, argv: ["/usr/bin/true", "a\rb"] })).toThrow(
      UnsafeScriptArgumentError,
    );
    expect(() =>
      renderLaunchScript({ cwd: CWD, argv: ["/usr/bin/true"], env: { KEY: "a\nb" } }),
    ).toThrow(UnsafeScriptArgumentError);
  });

  it("refuses an empty argv", () => {
    expect(() => renderLaunchScript({ cwd: CWD, argv: [] })).toThrow();
  });
});
