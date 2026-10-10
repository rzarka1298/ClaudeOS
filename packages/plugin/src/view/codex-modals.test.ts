import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODEX_ACTION_ERROR_CODES } from "@ccc/domain/codex-api.js";
import { Modal } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_REASONS,
  CodexFollowWarningModal,
  codexFollowWarningViewModel,
  codexReasonFor,
  codexTranscriptWarningViewModel,
  createObsidianCodexUi,
} from "./codex-modals.js";
import { TranscriptWarningModal } from "./session-modals.js";

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

describe("codexFollowWarningViewModel (UI-SPEC S3-b, R-16)", () => {
  it("carries the locked title, both bodies and exactly two buttons with Cancel focused", () => {
    const vm = codexFollowWarningViewModel();
    expect(vm.title).toBe("Follow this live log?");
    expect(vm.bodies).toEqual([
      "The live log is plain text on your Mac and can include prompts, replies and file contents. Anything readable by your user account can read it.",
      "It opens as a tab in this project's Antigravity window and only reads the log. It doesn't send anything to Codex.",
    ]);
    expect(vm.buttons.map((b) => b.label)).toEqual(["Follow in Antigravity", "Cancel"]);
    expect(vm.buttons.map((b) => b.cta)).toEqual([true, false]);
    expect(vm.initialFocus).toBe("cancel");
  });

  it("is a different, shorter modal than the transcript warning and says what the log can hold", () => {
    expect(codexFollowWarningViewModel().title).not.toBe(codexTranscriptWarningViewModel().title);
    expect(codexFollowWarningViewModel().bodies[0]).toContain("file contents");
  });

  it("has no remember, don't-ask-again or persisted field anywhere (key walk)", () => {
    const keys = allKeys(codexFollowWarningViewModel()).join(" ").toLowerCase();
    expect(keys).not.toMatch(/remember|dontshow|dontask|persist|suppress|skip|cache|checkbox/);
    expect(codexFollowWarningViewModel()).not.toBe(codexFollowWarningViewModel());
  });
});

describe("CodexFollowWarningModal (single-settle, no checkbox)", () => {
  it("settles exactly once; closing without a choice (Escape, outside click) resolves 'cancel'", () => {
    const decide = vi.fn();
    const modal = new CodexFollowWarningModal({} as never, codexFollowWarningViewModel(), decide);

    modal.open();
    modal.close();
    modal.close();

    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith("cancel");
  });

  it("renders no checkbox: the module never creates an input element", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "codex-modals.ts"), "utf8");
    expect(source).not.toMatch(/checkbox|createEl\("input"|type: "checkbox"|ToggleComponent/);
  });
});

describe("codex-modals source (Obsidian chrome, privacy)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "codex-modals.ts"), "utf8");

  it("carries no --ccc token, no HTML sink and no persistence call", () => {
    expect(source).not.toContain("--ccc-");
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    expect(source).not.toMatch(/localStorage|saveData|loadData|sessionStorage/);
  });
});

describe("createObsidianCodexUi (production seam against the Obsidian stub)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Replaces `Modal.open` so the test can reach the instance the opener built. */
  function captureModal(): { readonly get: () => Modal | undefined } {
    let captured: Modal | undefined;
    vi.spyOn(Modal.prototype, "open").mockImplementation(function (this: Modal) {
      captured = this;
    });
    return { get: () => captured };
  }

  it("returns the two Codex openers", () => {
    const ui = createObsidianCodexUi({} as never);
    expect(typeof ui.openCodexTranscriptWarning).toBe("function");
    expect(typeof ui.openCodexFollowWarning).toBe("function");
  });

  it("the transcript opener reuses the existing TranscriptWarningModal and resolves cancel when closed with no choice", async () => {
    const seen = captureModal();
    const ui = createObsidianCodexUi({} as never);

    const answer = ui.openCodexTranscriptWarning(codexTranscriptWarningViewModel());
    expect(seen.get()).toBeInstanceOf(TranscriptWarningModal);
    seen.get()?.close();

    await expect(answer).resolves.toBe("cancel");
  });

  it("the follow opener opens a CodexFollowWarningModal and resolves cancel when closed with no choice", async () => {
    const seen = captureModal();
    const ui = createObsidianCodexUi({} as never);

    const answer = ui.openCodexFollowWarning(codexFollowWarningViewModel());
    expect(seen.get()).toBeInstanceOf(CodexFollowWarningModal);
    seen.get()?.close();

    await expect(answer).resolves.toBe("cancel");
  });
});
