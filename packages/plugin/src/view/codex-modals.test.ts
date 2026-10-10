import { CODEX_ACTION_ERROR_CODES } from "@ccc/domain/codex-api.js";
import { describe, expect, it } from "vitest";
import { CODEX_REASONS, codexReasonFor, codexTranscriptWarningViewModel } from "./codex-modals.js";

/** Collects every key (at any depth) of a plain value. */
function allKeys(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, into);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      into.push(key);
      allKeys(child, into);
    }
  }
  return into;
}

describe("codexTranscriptWarningViewModel (UI-SPEC S3-a, D-29, CODEX-07)", () => {
  it("carries the locked title, both bodies and the three buttons with Cancel focused", () => {
    const vm = codexTranscriptWarningViewModel();
    expect(vm.title).toBe("Open this transcript?");
    expect(vm.bodies).toEqual([
      "Codex stores this transcript on your Mac as plain text. Anything readable by your user account can read it.",
      "Codex decides how long it keeps it. This app doesn't manage, copy or protect it.",
    ]);
    expect(vm.buttons.map((b) => b.label)).toEqual([
      "Show in Finder",
      "Open with default app",
      "Cancel",
    ]);
    expect(vm.buttons.map((b) => b.cta)).toEqual([true, false, false]);
    expect(vm.buttons.some((b) => b.destructive)).toBe(false);
    expect(vm.initialFocus).toBe("cancel");
  });

  it("has no remember, don't-ask-again or persisted field anywhere (key walk)", () => {
    const keys = allKeys(codexTranscriptWarningViewModel()).join(" ").toLowerCase();
    expect(keys).not.toMatch(/remember|dontshow|dontask|persist|suppress|skip|cache|checkbox/);
    expect(JSON.stringify(codexTranscriptWarningViewModel()).toLowerCase()).not.toMatch(
      /remember|don't ask|dont ask|don't show|dontshow/,
    );
  });

  it("returns a fresh object each call, so nothing can be cached on it", () => {
    expect(codexTranscriptWarningViewModel()).not.toBe(codexTranscriptWarningViewModel());
  });
});

describe("codexReasonFor (UI-SPEC S3 fixed reason vocabulary)", () => {
  it("is exactly the seven locked reasons", () => {
    expect([...CODEX_REASONS]).toEqual([
      "the file wasn't found",
      "it isn't in Codex's sessions folder",
      "the run has ended",
      "the bridge isn't installed",
      "the bridge is out of date",
      "Antigravity is still starting",
      "the service didn't respond",
    ]);
  });

  it("maps the named action codes to their own reason", () => {
    expect(codexReasonFor("not-found")).toBe("the file wasn't found");
    expect(codexReasonFor("outside-sessions-folder")).toBe("it isn't in Codex's sessions folder");
    expect(codexReasonFor("run-ended")).toBe("the run has ended");
    expect(codexReasonFor("bridge-not-installed")).toBe("the bridge isn't installed");
    expect(codexReasonFor("bridge-outdated")).toBe("the bridge is out of date");
    expect(codexReasonFor("window-not-ready")).toBe("Antigravity is still starting");
  });

  it("maps every server and client code to exactly one reason from the fixed seven", () => {
    const codes = [
      ...CODEX_ACTION_ERROR_CODES,
      "unrecognised-response",
      "timeout",
      "service-disconnected",
    ];
    for (const code of codes) {
      expect(CODEX_REASONS).toContain(codexReasonFor(code));
    }
  });

  it("maps an unknown code to the service-didn't-respond reason, never the raw code", () => {
    expect(codexReasonFor("made-up-code")).toBe("the service didn't respond");
    expect(codexReasonFor("")).toBe("the service didn't respond");
  });
});
