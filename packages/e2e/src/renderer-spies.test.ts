import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearConsoleErrors,
  fireNotificationClick,
  installConsoleCapture,
  installLongtaskObserver,
  installNotificationSpy,
  installSaveDialogStub,
  readConsoleErrors,
  readLongtasks,
  readNotifications,
  readSaveDialogCalls,
  resetLongtasks,
  restoreDocumentHasFocus,
  restoreSaveDialog,
  serialiseForRenderer,
  stubDocumentHasFocus,
} from "./renderer-spies.js";
import { rendererInstallSpies, rendererReadSpies } from "./spec-support/research-dom.js";

class FakeNotification {
  static permission = "granted";
  static requestCalls = 0;
  static async requestPermission(): Promise<string> {
    FakeNotification.requestCalls += 1;
    return "granted";
  }
  static constructed = 0;
  onclick: ((event: unknown) => void) | null = null;
  constructor(
    public title: string,
    public options?: { body?: string; tag?: string },
  ) {
    FakeNotification.constructed += 1;
  }
}

class FakePerformanceObserver {
  static supportedEntryTypes: string[] = ["longtask"];
  static last: FakePerformanceObserver | null = null;
  observed: unknown = null;
  constructor(public callback: (list: { getEntries(): unknown[] }) => void) {
    FakePerformanceObserver.last = this;
  }
  observe(options: unknown): void {
    this.observed = options;
  }
  disconnect(): void {}
  emit(entries: unknown[]): void {
    this.callback({ getEntries: () => entries });
  }
}

interface FakeWindow {
  Notification?: unknown;
  PerformanceObserver?: unknown;
  activeDocument?: unknown;
  addEventListener(type: string, fn: (event: unknown) => void): void;
  dispatch(type: string, event: unknown): void;
  [key: string]: unknown;
}

function makeWindow(extra: Partial<FakeWindow> = {}): FakeWindow {
  const listeners: Record<string, Array<(event: unknown) => void>> = {};
  return {
    addEventListener(type, fn) {
      let list = listeners[type];
      if (list === undefined) {
        list = [];
        listeners[type] = list;
      }
      list.push(fn);
    },
    dispatch(type, event) {
      for (const fn of listeners[type] ?? []) fn(event);
    },
    ...extra,
  };
}

function makeConsole() {
  const calls: unknown[][] = [];
  return {
    calls,
    error: (...args: unknown[]) => {
      calls.push(args);
    },
  };
}

beforeEach(() => {
  FakeNotification.permission = "granted";
  FakeNotification.requestCalls = 0;
  FakeNotification.constructed = 0;
  FakePerformanceObserver.last = null;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("notification spy (Test 1)", () => {
  function setup() {
    const win = makeWindow({ Notification: FakeNotification });
    const doc = { hasFocus: () => true };
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", doc);
    return win;
  }

  it("records title, body and tag per construction and keeps every instance", () => {
    const win = setup();
    expect(installNotificationSpy()).toBe(true);
    const Wrapped = win.Notification as typeof FakeNotification;
    const first = new Wrapped("Approval needed", { body: "Test request", tag: "a1" });
    new Wrapped("Second", { body: "More" });
    first.onclick = () => {};
    const read = readNotifications();
    expect(read.installed).toBe(true);
    expect(read.permission).toBe("granted");
    expect(read.records).toEqual([
      { title: "Approval needed", body: "Test request", tag: "a1", hasOnclick: true },
      { title: "Second", body: "More", tag: null, hasOnclick: false },
    ]);
    expect(JSON.parse(JSON.stringify(read))).toEqual(read);
  });

  it("never constructs the real notification, so no native banner is shown during a run", () => {
    const win = setup();
    installNotificationSpy();
    const Wrapped = win.Notification as typeof FakeNotification;
    const made = new Wrapped("Approval needed", { body: "x", tag: "t" });
    expect(FakeNotification.constructed).toBe(0);
    expect(made.onclick).toBeNull();
    expect(readNotifications().records).toHaveLength(1);
  });

  it("fires the retained handler once and reports false for a missing handler or index", () => {
    const win = setup();
    installNotificationSpy();
    const Wrapped = win.Notification as typeof FakeNotification;
    const a = new Wrapped("A");
    new Wrapped("B");
    let clicks = 0;
    a.onclick = () => {
      clicks += 1;
    };
    expect(fireNotificationClick(0)).toBe(true);
    expect(clicks).toBe(1);
    expect(fireNotificationClick(1)).toBe(false);
    expect(fireNotificationClick(7)).toBe(false);
    expect(fireNotificationClick(-1)).toBe(false);
    expect(clicks).toBe(1);
  });

  it("records each notification once when installed twice", () => {
    const win = setup();
    expect(installNotificationSpy()).toBe(true);
    expect(installNotificationSpy()).toBe(false);
    const Wrapped = win.Notification as typeof FakeNotification;
    new Wrapped("Once");
    expect(readNotifications().records).toHaveLength(1);
  });

  it("keeps permission and requestPermission behaving as the original", async () => {
    const win = setup();
    installNotificationSpy();
    const Wrapped = win.Notification as typeof FakeNotification;
    expect(Wrapped.permission).toBe("granted");
    FakeNotification.permission = "denied";
    expect(Wrapped.permission).toBe("denied");
    await expect(Wrapped.requestPermission()).resolves.toBe("granted");
    expect(FakeNotification.requestCalls).toBe(1);
  });

  it("reports not installed and empty before the spy exists, and when there is no Notification", () => {
    setup();
    expect(readNotifications()).toEqual({ installed: false, permission: null, records: [] });
    vi.stubGlobal("window", makeWindow());
    expect(installNotificationSpy()).toBe(false);
  });
});

describe("long task observer (Test 2)", () => {
  it("collects entries from the observer and resets", () => {
    vi.stubGlobal("window", makeWindow({ PerformanceObserver: FakePerformanceObserver }));
    expect(installLongtaskObserver()).toBe(true);
    expect(installLongtaskObserver()).toBe(true);
    FakePerformanceObserver.last?.emit([
      { startTime: 10.4, duration: 120.6, name: "self", extra: "ignored" },
    ]);
    const read = readLongtasks();
    expect(read.supported).toBe(true);
    expect(read.entries).toEqual([{ startTime: 10, duration: 121 }]);
    expect(resetLongtasks()).toBe(true);
    expect(readLongtasks().entries).toEqual([]);
  });

  it("reports supported false with no entries when the entry type is unavailable", () => {
    class NoLongtask extends FakePerformanceObserver {
      static override supportedEntryTypes: string[] = ["mark"];
    }
    vi.stubGlobal("window", makeWindow({ PerformanceObserver: NoLongtask }));
    expect(installLongtaskObserver()).toBe(false);
    expect(readLongtasks()).toEqual({ supported: false, entries: [] });
    vi.stubGlobal("window", makeWindow());
    expect(installLongtaskObserver()).toBe(false);
    expect(readLongtasks()).toEqual({ supported: false, entries: [] });
  });
});

describe("console capture (Test 3)", () => {
  it("records console.error and window error events, truncated, and still calls the original", () => {
    const win = makeWindow();
    const fake = makeConsole();
    vi.stubGlobal("window", win);
    vi.stubGlobal("console", fake);
    expect(installConsoleCapture()).toBe(true);
    expect(installConsoleCapture()).toBe(false);
    const long = "x".repeat(900);
    (fake as unknown as { error: (...a: unknown[]) => void }).error(
      "boom",
      { a: 1 },
      new Error("bad"),
    );
    (fake as unknown as { error: (...a: unknown[]) => void }).error(long);
    win.dispatch("error", { message: "window failed" });
    const errors = readConsoleErrors();
    expect(errors).toHaveLength(3);
    expect(errors[0]).toEqual({
      kind: "console.error",
      message: "boom [object Object] bad",
    });
    expect(errors[1]?.message.length).toBeLessThanOrEqual(300);
    expect(errors[1]?.message.length).toBeGreaterThan(100);
    expect(errors[2]).toEqual({ kind: "window.error", message: "window failed" });
    expect(fake.calls).toHaveLength(2);
    expect(clearConsoleErrors()).toBe(true);
    expect(readConsoleErrors()).toEqual([]);
  });
});

describe("focus stub (Test 4)", () => {
  it("makes document.hasFocus return the stubbed value until restored", () => {
    const doc: { hasFocus: () => boolean } = { hasFocus: () => true };
    const original = doc.hasFocus;
    vi.stubGlobal("window", makeWindow({ activeDocument: doc }));
    vi.stubGlobal("document", doc);
    expect(stubDocumentHasFocus(false)).toBe(true);
    expect(doc.hasFocus()).toBe(false);
    stubDocumentHasFocus(true);
    expect(doc.hasFocus()).toBe(true);
    stubDocumentHasFocus(false);
    expect(restoreDocumentHasFocus()).toBe(true);
    expect(doc.hasFocus).toBe(original);
    expect(doc.hasFocus()).toBe(true);
    expect(restoreDocumentHasFocus()).toBe(false);
  });

  it("removes the own property on restore when hasFocus came from the prototype", () => {
    class Doc {
      hasFocus(): boolean {
        return true;
      }
    }
    const doc = new Doc();
    vi.stubGlobal("window", makeWindow());
    vi.stubGlobal("document", doc);
    stubDocumentHasFocus(false);
    expect(Object.hasOwn(doc, "hasFocus")).toBe(true);
    restoreDocumentHasFocus();
    expect(Object.hasOwn(doc, "hasFocus")).toBe(false);
    expect(doc.hasFocus()).toBe(true);
  });
});

describe("self-contained (Test 5)", () => {
  const exported: Record<string, (...args: never[]) => unknown> = {
    installNotificationSpy,
    readNotifications,
    fireNotificationClick,
    installLongtaskObserver,
    readLongtasks,
    resetLongtasks,
    installConsoleCapture,
    readConsoleErrors,
    clearConsoleErrors,
    stubDocumentHasFocus,
    restoreDocumentHasFocus,
  };

  function evalIn(name: string, scope: { window: unknown; document: unknown; console: unknown }) {
    const source = (exported[name] as (...args: never[]) => unknown).toString();
    // A fresh scope that contains only a fake window, document and console: no module state.
    const factory = new Function("window", "document", "console", `return (${source});`);
    return factory(scope.window, scope.document, scope.console) as (...args: unknown[]) => unknown;
  }

  it("each exported function works when serialised and evaluated in a fresh scope", () => {
    const win = makeWindow({
      Notification: FakeNotification,
      PerformanceObserver: FakePerformanceObserver,
    });
    const doc = { hasFocus: () => true };
    const scope = { window: win, document: doc, console: makeConsole() };
    // Make sure nothing leaks in through globals: the stubbed window is NOT the global one.
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("document", undefined);

    expect(evalIn("installNotificationSpy", scope)()).toBe(true);
    const Wrapped = win.Notification as typeof FakeNotification;
    const n = new Wrapped("Hello", { body: "B" });
    n.onclick = () => {};
    expect((evalIn("readNotifications", scope)() as { records: unknown[] }).records).toHaveLength(
      1,
    );
    expect(evalIn("fireNotificationClick", scope)(0)).toBe(true);

    expect(evalIn("installLongtaskObserver", scope)()).toBe(true);
    FakePerformanceObserver.last?.emit([{ startTime: 1, duration: 60 }]);
    expect((evalIn("readLongtasks", scope)() as { entries: unknown[] }).entries).toHaveLength(1);
    expect(evalIn("resetLongtasks", scope)()).toBe(true);

    expect(evalIn("installConsoleCapture", scope)()).toBe(true);
    (scope.console as ReturnType<typeof makeConsole>).error("seen");
    expect(evalIn("readConsoleErrors", scope)() as unknown[]).toHaveLength(1);
    expect(evalIn("clearConsoleErrors", scope)()).toBe(true);

    expect(evalIn("stubDocumentHasFocus", scope)(false)).toBe(true);
    expect(doc.hasFocus()).toBe(false);
    expect(evalIn("restoreDocumentHasFocus", scope)()).toBe(true);
    expect(doc.hasFocus()).toBe(true);
  });

  it("no function body names another export or an import (no closure over module state)", () => {
    const names = Object.keys(exported);
    for (const name of names) {
      const source = (exported[name] as (...args: never[]) => unknown).toString();
      for (const other of names) {
        if (other === name) continue;
        expect(source.includes(`${other}(`), `${name} calls ${other}`).toBe(false);
      }
      expect(source).not.toMatch(/\brequire\b|\bimport\b|\bprocess\b|\bstate\b\./);
    }
  });
});

// ---------------------------------------------------------------------------
// Plan 08-20 Task 3: the save dialog stub

type DialogOptions = {
  title?: string;
  buttonLabel?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
  properties?: string[];
};

interface FakeDialog {
  showSaveDialog?: (options: DialogOptions) => Promise<{ canceled: boolean; filePath?: string }>;
  showOpenDialog?: () => Promise<unknown>;
}

const OWNER_OPTIONS: DialogOptions = {
  title: "Save diagnostic bundle",
  buttonLabel: "Save bundle",
  defaultPath: "claude-command-center-diagnostics-2026-10-23.json",
  filters: [{ name: "JSON", extensions: ["json"] }],
  properties: ["createDirectory", "showOverwriteConfirmation"],
};

function makeDialogWindow(dialog: FakeDialog | undefined, withRequire = true) {
  const electron = dialog === undefined ? { remote: undefined } : { remote: { dialog } };
  return {
    ...(withRequire
      ? {
          require: (name: string) => {
            if (name !== "electron") throw new Error("unexpected module");
            return electron;
          },
        }
      : {}),
  } as Record<string, unknown>;
}

/** A renderer function evaluated against a fake window, as wdio would evaluate it in the page. */
function inPage<A extends unknown[], R>(
  fn: (...args: A) => R,
  win: Record<string, unknown>,
): (...args: A) => R {
  const factory = new Function("window", `return (${fn.toString()});`);
  return factory(win) as (...args: A) => R;
}

describe("installSaveDialogStub (Task 3 Test 2)", () => {
  const TARGET = "/tmp/ccc-uat.abc123/tmp/bundle.json";

  function setup(extra: Partial<FakeDialog> = {}) {
    let originalCalls = 0;
    const original: NonNullable<FakeDialog["showSaveDialog"]> = async () => {
      originalCalls += 1;
      return { canceled: true };
    };
    const dialog: FakeDialog = {
      showSaveDialog: original,
      showOpenDialog: async () => "open",
      ...extra,
    };
    const win = makeDialogWindow(dialog);
    return { dialog, win, original, calls: () => originalCalls };
  }

  it("replaces only showSaveDialog and answers the scripted path without opening the real dialog", async () => {
    const { dialog, win, original, calls } = setup();
    const openBefore = dialog.showOpenDialog;
    expect(inPage(installSaveDialogStub, win)({ kind: "picked", path: TARGET })).toEqual({
      installed: true,
      reason: null,
    });
    expect(dialog.showSaveDialog).not.toBe(original);
    expect(dialog.showOpenDialog).toBe(openBefore);
    const answer = await (dialog.showSaveDialog as NonNullable<FakeDialog["showSaveDialog"]>)(
      OWNER_OPTIONS,
    );
    expect(answer).toEqual({ canceled: false, filePath: TARGET });
    expect(calls()).toBe(0);
  });

  it("answers a cancel with no file path", async () => {
    const { dialog, win } = setup();
    inPage(installSaveDialogStub, win)({ kind: "cancelled" });
    const answer = await (dialog.showSaveDialog as NonNullable<FakeDialog["showSaveDialog"]>)(
      OWNER_OPTIONS,
    );
    expect(answer).toEqual({ canceled: true });
  });

  it("records the options it receives: a bare default name, the filters and the properties", async () => {
    const { dialog, win } = setup();
    inPage(installSaveDialogStub, win)({ kind: "picked", path: TARGET });
    await (dialog.showSaveDialog as NonNullable<FakeDialog["showSaveDialog"]>)(OWNER_OPTIONS);
    expect(inPage(readSaveDialogCalls, win)()).toEqual([
      {
        defaultPath: "claude-command-center-diagnostics-2026-10-23.json",
        bareDefaultName: true,
        filters: [{ name: "JSON", extensions: ["json"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      },
    ]);
  });

  it("marks a default path that names a folder as not bare, and records only fixed fields", async () => {
    const { dialog, win } = setup();
    inPage(installSaveDialogStub, win)({ kind: "cancelled" });
    await (dialog.showSaveDialog as NonNullable<FakeDialog["showSaveDialog"]>)({
      ...OWNER_OPTIONS,
      defaultPath: "/Users/username/Desktop/bundle.json",
      title: "a title that is not recorded",
    });
    const [call] = inPage(readSaveDialogCalls, win)();
    expect(call?.bareDefaultName).toBe(false);
    expect(Object.keys(call ?? {}).sort()).toEqual([
      "bareDefaultName",
      "defaultPath",
      "filters",
      "properties",
    ]);
  });

  it("restoreSaveDialog puts the original function back, once", () => {
    const { dialog, win, original } = setup();
    inPage(installSaveDialogStub, win)({ kind: "picked", path: TARGET });
    expect(inPage(restoreSaveDialog, win)()).toBe(true);
    expect(dialog.showSaveDialog).toBe(original);
    expect(inPage(restoreSaveDialog, win)()).toBe(false);
    expect(inPage(readSaveDialogCalls, win)()).toEqual([]);
  });

  it("installs once: a second install changes nothing and reports why", () => {
    const { dialog, win } = setup();
    expect(inPage(installSaveDialogStub, win)({ kind: "picked", path: TARGET }).installed).toBe(
      true,
    );
    const stub = dialog.showSaveDialog;
    expect(inPage(installSaveDialogStub, win)({ kind: "cancelled" })).toEqual({
      installed: false,
      reason: "already-installed",
    });
    expect(dialog.showSaveDialog).toBe(stub);
  });

  it("changes nothing and says why when there is no require, no remote dialog or no save function", () => {
    const noRequire = makeDialogWindow(undefined, false);
    expect(inPage(installSaveDialogStub, noRequire)({ kind: "cancelled" })).toEqual({
      installed: false,
      reason: "no-require",
    });
    const noRemote = makeDialogWindow(undefined);
    expect(inPage(installSaveDialogStub, noRemote)({ kind: "cancelled" })).toEqual({
      installed: false,
      reason: "no-dialog",
    });
    const noSave = makeDialogWindow({ showOpenDialog: async () => "open" });
    expect(inPage(installSaveDialogStub, noSave)({ kind: "cancelled" })).toEqual({
      installed: false,
      reason: "no-dialog",
    });
  });

  it("refuses an answer that is not a picked absolute json path or a cancel", () => {
    for (const bad of [
      { kind: "picked", path: "relative.json" },
      { kind: "picked", path: "/tmp/x.txt" },
      { kind: "picked", path: "" },
      { kind: "other" },
    ]) {
      const { dialog, win, original } = setup();
      expect(inPage(installSaveDialogStub, win)(bad as never), JSON.stringify(bad)).toEqual({
        installed: false,
        reason: "bad-answer",
      });
      expect(dialog.showSaveDialog).toBe(original);
    }
  });

  it("holds no path of its own: the serialised script names only the path the test passes", () => {
    const script = serialiseForRenderer(installSaveDialogStub, { kind: "picked", path: TARGET });
    expect(script.split(TARGET)).toHaveLength(2);
    const withoutTarget = script.split(TARGET).join("");
    expect(withoutTarget).not.toMatch(/\/(?:Users|home|tmp|private|var)\//);
    expect(String(installSaveDialogStub)).not.toMatch(/\/(?:Users|home|tmp|private|var)\//);
    expect(String(restoreSaveDialog)).not.toMatch(/\/(?:Users|home|tmp|private|var)\//);
  });

  it("is self-contained: it needs no module state and no __name helper", () => {
    for (const fn of [installSaveDialogStub, readSaveDialogCalls, restoreSaveDialog]) {
      const source = fn.toString();
      expect(source).not.toMatch(/\b__name\b|\bimport\b|\bprocess\b|\bstate\b\./);
    }
    for (const other of ["readSaveDialogCalls(", "restoreSaveDialog(", "serialiseForRenderer("]) {
      expect(installSaveDialogStub.toString().includes(other)).toBe(false);
    }
  });
});

describe("the clipboard spy captures the Copy payload (Task 3 Test 3)", () => {
  function clipboardWindow() {
    let real = 0;
    const win = {
      navigator: {
        clipboard: {
          writeText: async () => {
            real += 1;
          },
        },
      },
      Element: { prototype: { scrollIntoView: () => undefined } },
    };
    return { win: win as unknown as Record<string, unknown>, realWrites: () => real };
  }

  it("records the exact text a Copy writes, byte for byte, and never writes the real clipboard", async () => {
    const { win, realWrites } = clipboardWindow();
    expect(inPage(rendererInstallSpies, win)()).toBe(true);
    const payload = '{\n  "bundleVersion": 1,\n  "text": "ünï — \t tab"\n}';
    await (
      win["navigator"] as { clipboard: { writeText(t: string): Promise<void> } }
    ).clipboard.writeText(payload);
    const seen = inPage(rendererReadSpies, win)();
    expect(seen.clipboard).toEqual([payload]);
    expect(
      Buffer.from(seen.clipboard[0] as string, "utf8").equals(Buffer.from(payload, "utf8")),
    ).toBe(true);
    expect(realWrites()).toBe(0);
  });
});
