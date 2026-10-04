import { describe, expect, it } from "vitest";
import {
  activateApp,
  LaunchArgumentError,
  OPEN,
  openInApp,
  openTerminalScript,
  openUrl,
  revealInFinder,
  TERMINAL_BUNDLE_ID,
} from "./app-actions.js";

const PROJECT = "/Users/USERNAME/code/example-project";

function expectStringArray(argv: readonly unknown[]): void {
  expect(Array.isArray(argv)).toBe(true);
  for (const element of argv) {
    expect(typeof element).toBe("string");
  }
}

describe("app-actions argv builders (D-19)", () => {
  it("openInApp targets the app by bundle ID with the project path as its own element", () => {
    const argv = openInApp("com.google.antigravity", PROJECT);
    expect(argv).toEqual(["/usr/bin/open", "-b", "com.google.antigravity", PROJECT]);
    expectStringArray(argv);
  });

  it("activateApp foregrounds an app by bundle ID", () => {
    const argv = activateApp("com.anthropic.claudefordesktop");
    expect(argv).toEqual(["/usr/bin/open", "-b", "com.anthropic.claudefordesktop"]);
    expectStringArray(argv);
  });

  it("revealInFinder uses open -R", () => {
    const argv = revealInFinder(PROJECT);
    expect(argv).toEqual(["/usr/bin/open", "-R", PROJECT]);
    expectStringArray(argv);
  });

  it("openUrl hands an https URL to open", () => {
    const argv = openUrl("https://github.com/owner/repo");
    expect(argv).toEqual(["/usr/bin/open", "https://github.com/owner/repo"]);
    expectStringArray(argv);
  });

  it("openTerminalScript hands the script to Terminal.app by bundle ID", () => {
    const argv = openTerminalScript("/tmp/ccc/launch/abc.command");
    expect(argv).toEqual([
      "/usr/bin/open",
      "-b",
      "com.apple.Terminal",
      "/tmp/ccc/launch/abc.command",
    ]);
    expect(TERMINAL_BUNDLE_ID).toBe("com.apple.Terminal");
    expectStringArray(argv);
  });

  it("every builder starts with the absolute /usr/bin/open", () => {
    expect(OPEN).toBe("/usr/bin/open");
    for (const argv of [
      openInApp("a.b", PROJECT),
      activateApp("a.b"),
      revealInFinder(PROJECT),
      openUrl("https://github.com/o/r"),
      openTerminalScript("/tmp/x.command"),
    ]) {
      expect(argv[0]).toBe(OPEN);
    }
  });

  it("refuses a bundle ID outside ^[A-Za-z0-9.-]+$", () => {
    for (const bad of [
      "",
      "com.example app",
      "com.example;rm",
      "-a",
      "com/example",
      "Name.app\n",
    ]) {
      expect(() => openInApp(bad, PROJECT)).toThrow(LaunchArgumentError);
      expect(() => activateApp(bad)).toThrow(LaunchArgumentError);
    }
  });

  it("refuses a relative project or script path", () => {
    expect(() => openInApp("a.b", "code/example")).toThrow(LaunchArgumentError);
    expect(() => revealInFinder("-R")).toThrow(LaunchArgumentError);
    expect(() => openTerminalScript("x.command")).toThrow(LaunchArgumentError);
  });

  it("refuses a URL that is not https", () => {
    for (const bad of [
      "http://github.com/owner/repo",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "ssh://github.com/owner/repo",
      "not a url",
      "-a Calculator",
    ]) {
      expect(() => openUrl(bad)).toThrow(LaunchArgumentError);
    }
  });

  it("the refusal message is constant and never echoes the value", () => {
    let caught: unknown;
    try {
      openUrl("http://secret-host.invalid/private-path");
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LaunchArgumentError);
    const message = (caught as Error).message;
    expect(message).not.toContain("secret-host");
    expect(message).not.toContain("private-path");
  });
});
