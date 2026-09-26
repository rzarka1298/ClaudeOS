import {
  DetectionResponseSchema,
  TEMPLATE_REFUSAL_REASONS,
  TERMINAL_PRESET_IDS,
} from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { OPEN } from "./app-actions.js";
import {
  FORBIDDEN_CLAUDE_FLAGS,
  FORBIDDEN_PERMISSION_TOKENS,
  MAX_TEMPLATE_ARGS,
  PLACEHOLDERS,
  renderCommandTemplate,
  TERMINAL_PRESETS,
  type TemplateKind,
  type TemplateRefusal,
  validateCommandTemplate,
} from "./command-template.js";

const WEZTERM = "/opt/homebrew/bin/wezterm";
const CLAUDE = "/opt/homebrew/bin/claude";
const always = (_path: string): boolean => true;

function refusal(argv: readonly string[], kind: TemplateKind = "terminal", isExecutable = always) {
  const result = validateCommandTemplate(argv, { kind, isExecutable });
  if (result.ok) throw new Error("expected a refusal");
  return { reason: result.reason, index: result.index };
}

describe("validateCommandTemplate (D-22, PROJ-10)", () => {
  it("accepts a terminal template with a whole-token {script} and returns the same argv", () => {
    const argv = [WEZTERM, "start", "--", "{script}"];
    expect(validateCommandTemplate(argv, { kind: "terminal", isExecutable: always })).toEqual({
      ok: true,
      argv,
    });
  });

  it("accepts a Claude Code template with {projectPath} and no {script}", () => {
    const argv = [CLAUDE, "--add-dir", "{projectPath}", "--model", "opus"];
    expect(validateCommandTemplate(argv, { kind: "claude-code", isExecutable: always })).toEqual({
      ok: true,
      argv,
    });
  });

  // One case per TemplateRefusal reason, each asserting the reported index.
  const cases: ReadonlyArray<{
    readonly reason: TemplateRefusal;
    readonly argv: readonly string[];
    readonly kind?: TemplateKind;
    readonly isExecutable?: (path: string) => boolean;
    readonly index: number | null;
  }> = [
    { reason: "executable-not-absolute", argv: ["wezterm", "{script}"], index: 0 },
    {
      reason: "executable-not-executable",
      argv: [WEZTERM, "{script}"],
      isExecutable: () => false,
      index: 0,
    },
    {
      reason: "embedded-placeholder",
      argv: [WEZTERM, "--cwd={projectPath}", "{script}"],
      index: 1,
    },
    { reason: "missing-script-placeholder", argv: [WEZTERM, "start"], index: null },
    {
      reason: "forbidden-flag",
      argv: [CLAUDE, "--model", "opus", "--dangerously-skip-permissions"],
      kind: "claude-code",
      index: 3,
    },
    { reason: "empty-argument", argv: [WEZTERM, "", "{script}"], index: 1 },
    { reason: "line-break", argv: [WEZTERM, "{script}", "a\nb"], index: 2 },
    {
      reason: "too-many-arguments",
      argv: [WEZTERM, ...Array.from({ length: 31 }, () => "x"), "{script}"],
      index: MAX_TEMPLATE_ARGS,
    },
    { reason: "unknown-placeholder", argv: [WEZTERM, "{scrpt}", "{script}"], index: 1 },
  ];

  it.each(cases)("refuses with $reason at index $index", (c) => {
    expect(refusal(c.argv, c.kind ?? "terminal", c.isExecutable ?? always)).toEqual({
      reason: c.reason,
      index: c.index,
    });
  });

  it("covers every template refusal reason the domain declares except the service-side lookups", () => {
    const covered = new Set(cases.map((c) => c.reason));
    const expected = TEMPLATE_REFUSAL_REASONS.filter(
      (r) => r !== "bundle-not-found" && r !== "executable-not-found",
    );
    expect([...covered].sort()).toEqual([...expected].sort());
  });

  it("refuses the permission-bypass flag with a value, and in a terminal template", () => {
    expect(refusal([CLAUDE, "--dangerously-skip-permissions=true"], "claude-code")).toEqual({
      reason: "forbidden-flag",
      index: 1,
    });
    expect(refusal([WEZTERM, "{script}", "--dangerously-skip-permissions"])).toEqual({
      reason: "forbidden-flag",
      index: 2,
    });
    expect(FORBIDDEN_CLAUDE_FLAGS).toContain("--dangerously-skip-permissions");
  });

  it("refuses prefixed and differently-cased spellings of the permission-bypass flag", () => {
    for (const spelling of [
      "--allow-dangerously-skip-permissions",
      "--DANGEROUSLY-SKIP-PERMISSIONS",
      "-dangerously-skip-permissions",
    ]) {
      expect(refusal([CLAUDE, spelling], "claude-code")).toEqual({
        reason: "forbidden-flag",
        index: 1,
      });
    }
  });

  it("refuses the permission bypass in every spelling once case and punctuation are stripped", () => {
    expect([...FORBIDDEN_PERMISSION_TOKENS]).toEqual([
      "dangerouslyskippermissions",
      "bypasspermissions",
    ]);
    for (const spelling of [
      "--dangerously_skip_permissions",
      "--Dangerously.Skip.Permissions",
      "--dangerously skip permissions",
      "--permission-mode=bypassPermissions",
      "--permission-mode=bypass-permissions",
      "bypassPermissions",
    ]) {
      expect(refusal([CLAUDE, spelling], "claude-code")).toEqual({
        reason: "forbidden-flag",
        index: 1,
      });
    }
  });

  it("refuses --permission-mode followed by bypassPermissions as a separate element", () => {
    expect(refusal([CLAUDE, "--permission-mode", "bypassPermissions"], "claude-code")).toEqual({
      reason: "forbidden-flag",
      index: 2,
    });
    expect(refusal([WEZTERM, "{script}", "--permission-mode", "BYPASS_PERMISSIONS"])).toEqual({
      reason: "forbidden-flag",
      index: 3,
    });
  });

  it("refuses a --settings JSON value that sets defaultMode to bypassPermissions", () => {
    const settings = '{"permissions":{"defaultMode":"bypassPermissions"}}';
    expect(refusal([CLAUDE, "--settings", settings], "claude-code")).toEqual({
      reason: "forbidden-flag",
      index: 2,
    });
    expect(refusal([CLAUDE, `--settings=${settings}`], "claude-code")).toEqual({
      reason: "forbidden-flag",
      index: 1,
    });
  });

  it("still accepts the non-bypass permission modes -- the check discriminates", () => {
    for (const mode of ["default", "acceptEdits", "plan"]) {
      expect(
        validateCommandTemplate([CLAUDE, "--permission-mode", mode], {
          kind: "claude-code",
          isExecutable: always,
        }).ok,
      ).toBe(true);
    }
  });

  it("refuses a carriage return as a line break", () => {
    expect(refusal([WEZTERM, "a\rb", "{script}"])).toEqual({ reason: "line-break", index: 1 });
  });

  it("accepts exactly 32 elements and refuses 33", () => {
    const at = [WEZTERM, ...Array.from({ length: 30 }, () => "x"), "{script}"];
    expect(at).toHaveLength(32);
    expect(validateCommandTemplate(at, { kind: "terminal", isExecutable: always }).ok).toBe(true);
    expect(refusal([...at, "y"]).reason).toBe("too-many-arguments");
  });

  it("refuses an empty template at the executable position", () => {
    expect(refusal([]).index).toBe(0);
  });

  it("in a Claude Code template {script} is an unknown placeholder", () => {
    expect(refusal([CLAUDE, "{script}"], "claude-code")).toEqual({
      reason: "unknown-placeholder",
      index: 1,
    });
  });

  it("refuses {script} embedded inside a larger argument", () => {
    expect(refusal([WEZTERM, "run:{script}", "{script}"])).toEqual({
      reason: "embedded-placeholder",
      index: 1,
    });
  });

  it("passes only argv[0] to isExecutable", () => {
    const seen: string[] = [];
    validateCommandTemplate([WEZTERM, "{script}"], {
      kind: "terminal",
      isExecutable: (p) => {
        seen.push(p);
        return true;
      },
    });
    expect(seen).toEqual([WEZTERM]);
  });

  it("is total: it never throws for any template shape", () => {
    for (const argv of [[], [""], ["{script}"], ["/", "{"], ["/x", "}{script}{"]]) {
      expect(() =>
        validateCommandTemplate(argv, { kind: "terminal", isExecutable: always }),
      ).not.toThrow();
    }
  });
});

describe("renderCommandTemplate", () => {
  it("replaces a whole-token placeholder and changes nothing else", () => {
    expect(
      renderCommandTemplate([OPEN, "-b", "x", "{script}"], { script: "/tmp/a b.command" }),
    ).toEqual([OPEN, "-b", "x", "/tmp/a b.command"]);
  });

  it("never splits or joins elements, even when a value holds spaces or quotes", () => {
    const out = renderCommandTemplate(
      [WEZTERM, "start", "--cwd", "{projectPath}", "--", "{script}"],
      { projectPath: "/Users/USERNAME/it's a dir", script: "/tmp/s.command" },
    );
    expect(out).toEqual([
      WEZTERM,
      "start",
      "--cwd",
      "/Users/USERNAME/it's a dir",
      "--",
      "/tmp/s.command",
    ]);
  });

  it("does not substitute inside a larger argument", () => {
    expect(renderCommandTemplate([WEZTERM, "x{script}"], { script: "/tmp/s" })).toEqual([
      WEZTERM,
      "x{script}",
    ]);
  });

  it("throws when a placeholder in the template has no value", () => {
    expect(() => renderCommandTemplate([WEZTERM, "{script}"], {})).toThrow();
  });

  it("declares exactly the two placeholders", () => {
    expect([...PLACEHOLDERS]).toEqual(["{projectPath}", "{script}"]);
  });
});

describe("TERMINAL_PRESETS (D-23)", () => {
  it("has the four preset ids the domain declares", () => {
    expect(TERMINAL_PRESETS.map((p) => p.id)).toEqual([...TERMINAL_PRESET_IDS]);
    expect(TERMINAL_PRESETS.map((p) => p.id)).toEqual(["iterm2", "ghostty", "wezterm", "blank"]);
  });

  const nonBlank = TERMINAL_PRESETS.filter((p) => p.id !== "blank");

  it("has three non-blank presets", () => {
    expect(nonBlank).toHaveLength(3);
  });

  it.each(nonBlank.map((p) => [p.id, p] as const))(
    "%s routes through open or osascript, has one {script}, validates and is unverified",
    (_id, preset) => {
      expect(["/usr/bin/open", "/usr/bin/osascript"]).toContain(preset.argv[0]);
      expect(preset.argv.filter((a) => a === "{script}")).toHaveLength(1);
      expect(
        validateCommandTemplate(preset.argv, { kind: "terminal", isExecutable: always }),
      ).toEqual({ ok: true, argv: preset.argv });
      expect(preset.verified).toBe(false);
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.note.length).toBeGreaterThan(0);
    },
  );

  it("every preset, including blank, is unverified", () => {
    for (const preset of TERMINAL_PRESETS) expect(preset.verified).toBe(false);
  });

  it("no preset element contains a forbidden permission token", () => {
    for (const preset of TERMINAL_PRESETS) {
      for (const element of preset.argv) {
        const normalised = element.toLowerCase().replace(/[^a-z0-9]/g, "");
        for (const token of FORBIDDEN_PERMISSION_TOKENS) expect(normalised).not.toContain(token);
      }
    }
  });

  it("the blank preset fails validation until the executable is filled in", () => {
    const blank = TERMINAL_PRESETS.find((p) => p.id === "blank");
    expect(blank?.argv).toEqual(["", "{script}"]);
    expect(
      validateCommandTemplate(blank?.argv ?? [], { kind: "terminal", isExecutable: always }).ok,
    ).toBe(false);
  });

  it("every preset, including blank, travels in a DetectionResponse that parses (D-27)", () => {
    const response = {
      detectedAt: "2026-09-26T00:00:00.000Z",
      apps: {
        antigravity: [],
        "claude-desktop": [],
        iterm2: [],
        ghostty: [],
        wezterm: [],
        terminal: [],
      },
      claudeExecutables: [],
      terminalPresets: TERMINAL_PRESETS.map(({ id, label, argv, verified }) => ({
        id,
        label,
        argv: [...argv],
        verified,
      })),
      git: "available",
    };
    const parsed = DetectionResponseSchema.safeParse(response);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.data?.terminalPresets.map((p) => p.id)).toEqual([...TERMINAL_PRESET_IDS]);
  });

  it("the iTerm2 preset passes the script as an AppleScript argv item, never inside the source", () => {
    const iterm = TERMINAL_PRESETS.find((p) => p.id === "iterm2");
    expect(iterm?.argv.at(-1)).toBe("{script}");
    const sources = (iterm?.argv ?? []).slice(0, -1);
    for (const element of sources) expect(element).not.toContain("{");
  });
});
