/**
 * Renderer spies for the live-UAT specs (05.2-04, D-05, E2E-04, T-05.2-17).
 *
 * Every exported function is SELF-CONTAINED: no imports, no outer variables, no calls to
 * another export. wdio serialises a function body with `toString()` and evaluates it in the
 * Obsidian renderer (`browser.execute` / `browser.executeObsidian`), so a closure over module
 * state would be undefined there. State lives on one namespaced property of the window object
 * (`window.__cccUatSpies`), so a plugin reload (which changes the plugin, not the window)
 * does not lose it. Results are plain serialisable data; captured messages are truncated and
 * never include DOM content; the specs decide what they may record.
 *
 * Recorded spike decisions (05.2-RESEARCH.md "Spike results", orchestrator run 2026-10-11):
 * - S1 passed: the window reports focus and notification permission is granted, but the plugin
 *   created no notification in the probe, so `installNotificationSpy` plus
 *   `stubDocumentHasFocus(false)` is how a spec observes the approval banner path.
 * - S3 failed (protocolDispatch onclick-only): the `ccc-approval` handler is not reachable
 *   in process. `fireNotificationClick` (the retained instance's click handler) is therefore
 *   the ONLY in-process way to exercise the banner-click deep link; a test-4 style protocol
 *   deep link stays owner or auto-part only.
 */

interface RendererDocument {
  hasFocus: () => boolean;
}

interface RendererWindow {
  Notification?: unknown;
  PerformanceObserver?: unknown;
  activeDocument?: RendererDocument;
  addEventListener?: (type: string, listener: (event: unknown) => void) => void;
  __cccUatSpies?: Record<string, unknown>;
}

declare const window: RendererWindow;
declare const document: RendererDocument;

/** Installs a Notification wrapper that records {title, body, tag} and retains every instance. */
export function installNotificationSpy(): boolean {
  const w = window as RendererWindow;
  const ns = w.__cccUatSpies ?? {};
  w.__cccUatSpies = ns;
  if (ns["notificationOriginal"] !== undefined) return false;
  const Original = w.Notification as
    | ((new (
        title: string,
        options?: { body?: string; tag?: string },
      ) => unknown) & {
        permission?: string;
        requestPermission?: (...args: unknown[]) => unknown;
      })
    | undefined;
  if (typeof Original !== "function") return false;
  const kept: Array<{
    instance: { onclick?: unknown };
    title: string;
    body: string | null;
    tag: string | null;
  }> = [];
  ns["notificationOriginal"] = Original;
  ns["notifications"] = kept;
  // biome-ignore lint/complexity/useArrowFunction: the wrapper is called with `new`, so it must be a constructible function, not an arrow.
  const Wrapper = function (title: string, options?: { body?: string; tag?: string }) {
    const instance = new Original(title, options) as { onclick?: unknown };
    kept.push({
      instance,
      title: String(title),
      body: typeof options?.body === "string" ? options.body : null,
      tag: typeof options?.tag === "string" ? options.tag : null,
    });
    return instance;
  } as unknown as typeof Original;
  Wrapper.prototype = Original.prototype;
  Object.defineProperty(Wrapper, "permission", {
    get: () => Original.permission,
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(Wrapper, "requestPermission", {
    value: (...args: unknown[]) => Original.requestPermission?.(...args),
    writable: true,
    configurable: true,
  });
  w.Notification = Wrapper;
  return true;
}

/** Returns the recorded notifications as serialisable data; the instances stay in the page. */
export function readNotifications(): {
  installed: boolean;
  permission: string | null;
  records: Array<{ title: string; body: string | null; tag: string | null; hasOnclick: boolean }>;
} {
  const w = window as RendererWindow;
  const ns = w.__cccUatSpies;
  const kept = ns?.["notifications"] as
    | Array<{
        instance: { onclick?: unknown };
        title: string;
        body: string | null;
        tag: string | null;
      }>
    | undefined;
  if (ns === undefined || kept === undefined) {
    return { installed: false, permission: null, records: [] };
  }
  const current = w.Notification as { permission?: string } | undefined;
  return {
    installed: true,
    permission: typeof current?.permission === "string" ? current.permission : null,
    records: kept.map((entry) => ({
      title: entry.title,
      body: entry.body,
      tag: entry.tag,
      hasOnclick: typeof entry.instance.onclick === "function",
    })),
  };
}

/** Calls the retained instance's click handler once; false when there is none to call. */
export function fireNotificationClick(index: number): boolean {
  const w = window as RendererWindow;
  const kept = w.__cccUatSpies?.["notifications"] as
    | Array<{ instance: { onclick?: unknown } }>
    | undefined;
  if (kept === undefined || !Number.isInteger(index) || index < 0 || index >= kept.length) {
    return false;
  }
  const entry = kept[index];
  const handler = entry?.instance.onclick;
  if (typeof handler !== "function") return false;
  handler.call(entry?.instance, { type: "click" });
  return true;
}

/** Starts collecting long-task entries; false (inconclusive, never a pass) when unsupported. */
export function installLongtaskObserver(): boolean {
  const w = window as RendererWindow;
  const ns = w.__cccUatSpies ?? {};
  w.__cccUatSpies = ns;
  if (ns["longtaskObserver"] !== undefined) return true;
  const Observer = w.PerformanceObserver as
    | ((new (
        callback: (list: { getEntries(): Array<{ startTime: number; duration: number }> }) => void,
      ) => { observe(options: unknown): void }) & { supportedEntryTypes?: string[] })
    | undefined;
  const supported =
    typeof Observer === "function" &&
    Array.isArray(Observer.supportedEntryTypes) &&
    Observer.supportedEntryTypes.includes("longtask");
  ns["longtaskSupported"] = supported;
  ns["longtasks"] = [] as Array<{ startTime: number; duration: number }>;
  if (!supported || Observer === undefined) return false;
  const observer = new Observer((list) => {
    const store = ns["longtasks"] as Array<{ startTime: number; duration: number }>;
    for (const entry of list.getEntries()) {
      store.push({ startTime: Math.round(entry.startTime), duration: Math.round(entry.duration) });
    }
  });
  observer.observe({ entryTypes: ["longtask"] });
  ns["longtaskObserver"] = observer;
  return true;
}

/** The collected long tasks; `supported` false means the caller must treat it as inconclusive. */
export function readLongtasks(): {
  supported: boolean;
  entries: Array<{ startTime: number; duration: number }>;
} {
  const ns = (window as RendererWindow).__cccUatSpies;
  if (ns === undefined || ns["longtaskSupported"] !== true)
    return { supported: false, entries: [] };
  const store = ns["longtasks"] as Array<{ startTime: number; duration: number }>;
  return { supported: true, entries: store.map((entry) => ({ ...entry })) };
}

/** Clears the collected long tasks. */
export function resetLongtasks(): boolean {
  const ns = (window as RendererWindow).__cccUatSpies;
  const store = ns?.["longtasks"] as unknown[] | undefined;
  if (store === undefined) return false;
  store.length = 0;
  return true;
}

/** Records console.error calls and window error events (message text only, truncated). */
export function installConsoleCapture(): boolean {
  const w = window as RendererWindow;
  const ns = w.__cccUatSpies ?? {};
  w.__cccUatSpies = ns;
  if (ns["consoleErrors"] !== undefined) return false;
  const errors: Array<{ kind: string; message: string }> = [];
  ns["consoleErrors"] = errors;
  const original = console.error;
  console.error = (...args: unknown[]) => {
    const text = args
      .map((arg) => (arg instanceof Error ? arg.message : String(arg)))
      .join(" ")
      .slice(0, 300);
    errors.push({ kind: "console.error", message: text });
    return original.apply(console, args as never);
  };
  w.addEventListener?.("error", (event) => {
    const message = (event as { message?: unknown } | null)?.message;
    errors.push({ kind: "window.error", message: String(message ?? "").slice(0, 300) });
  });
  w.addEventListener?.("unhandledrejection", (event) => {
    const reason = (event as { reason?: unknown } | null)?.reason;
    const text = reason instanceof Error ? reason.message : String(reason ?? "");
    errors.push({ kind: "unhandledrejection", message: text.slice(0, 300) });
  });
  return true;
}

/** The captured errors, as plain objects. */
export function readConsoleErrors(): Array<{ kind: string; message: string }> {
  const errors = (window as RendererWindow).__cccUatSpies?.["consoleErrors"] as
    | Array<{ kind: string; message: string }>
    | undefined;
  return errors === undefined ? [] : errors.map((entry) => ({ ...entry }));
}

/** Empties the captured errors. */
export function clearConsoleErrors(): boolean {
  const errors = (window as RendererWindow).__cccUatSpies?.["consoleErrors"] as
    | unknown[]
    | undefined;
  if (errors === undefined) return false;
  errors.length = 0;
  return true;
}

/** Makes document.hasFocus (and activeDocument.hasFocus, if distinct) return `value`. */
export function stubDocumentHasFocus(value: boolean): boolean {
  const w = window as RendererWindow;
  const ns = w.__cccUatSpies ?? {};
  w.__cccUatSpies = ns;
  const targets: RendererDocument[] = [document];
  if (w.activeDocument !== undefined && w.activeDocument !== document) {
    targets.push(w.activeDocument);
  }
  let saved = ns["focusSaved"] as
    | Array<{ target: RendererDocument; descriptor: PropertyDescriptor | undefined }>
    | undefined;
  if (saved === undefined) {
    saved = targets.map((target) => ({
      target,
      descriptor: Object.getOwnPropertyDescriptor(target, "hasFocus"),
    }));
    ns["focusSaved"] = saved;
  }
  for (const target of targets) {
    target.hasFocus = () => value;
  }
  return true;
}

/** Restores document.hasFocus; false when nothing was stubbed. */
export function restoreDocumentHasFocus(): boolean {
  const ns = (window as RendererWindow).__cccUatSpies;
  const saved = ns?.["focusSaved"] as
    | Array<{ target: RendererDocument; descriptor: PropertyDescriptor | undefined }>
    | undefined;
  if (ns === undefined || saved === undefined) return false;
  for (const { target, descriptor } of saved) {
    if (descriptor === undefined) {
      delete (target as { hasFocus?: unknown }).hasFocus;
    } else {
      Object.defineProperty(target, "hasFocus", descriptor);
    }
  }
  ns["focusSaved"] = undefined;
  return true;
}
