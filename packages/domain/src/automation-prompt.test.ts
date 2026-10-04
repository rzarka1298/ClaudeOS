import { describe, expect, it } from "vitest";
import { terminalMayPromptForAutomation } from "./launch.js";

/**
 * Wave-5 review finding 10: a custom terminal template that runs osascript
 * anywhere in its argv — through `env`, a shell, or a differently located
 * copy — can raise macOS's Automation prompt just as `/usr/bin/osascript` as
 * the executable can, so its Test must get the Automation cap too.
 */

function custom(argv: string[]) {
  return { kind: "custom", preset: "blank", argv } as const;
}

describe("terminalMayPromptForAutomation sees osascript anywhere (finding 10)", () => {
  it.each([
    [["/usr/bin/env", "osascript", "-e", "tell app", "{script}"]],
    [["/usr/bin/env", "/usr/bin/osascript", "{script}"]],
    [["/opt/homebrew/bin/osascript", "{script}"]],
    [["/bin/sh", "{script}", "/usr/bin/OSASCRIPT"]],
  ])("treats %j as automation-capable", (argv) => {
    expect(terminalMayPromptForAutomation(custom(argv))).toBe(true);
  });

  it.each([
    [["/usr/bin/open", "-na", "Ghostty", "--args", "-e", "{script}"]],
    [["/Applications/WezTerm.app/Contents/MacOS/wezterm", "start", "--", "{script}"]],
    [["/usr/bin/env", "osascripted", "{script}"]],
  ])("leaves %j alone", (argv) => {
    expect(terminalMayPromptForAutomation(custom(argv))).toBe(false);
  });

  it("Terminal.app's default hand-off still never prompts", () => {
    expect(terminalMayPromptForAutomation({ kind: "terminal-app" })).toBe(false);
  });
});
