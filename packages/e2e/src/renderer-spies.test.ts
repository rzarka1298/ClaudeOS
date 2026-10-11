import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearConsoleErrors,
  fireNotificationClick,
  installConsoleCapture,
  installLongtaskObserver,
  installNotificationSpy,
  readConsoleErrors,
  readLongtasks,
  readNotifications,
  resetLongtasks,
  restoreDocumentHasFocus,
  stubDocumentHasFocus,
} from "./renderer-spies.js";

class FakeNotification {
  static permission = "granted";
  static requestCalls = 0;
  static async requestPermission(): Promise<string> {
    FakeNotification.requestCalls += 1;
    return "granted";
  }
  onclick: ((event: unknown) => void) | null = null;
  constructor(
    public title: string,
    public options?: { body?: string; tag?: string },
  ) {}
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
