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

/**
 * Builds the script body wdio sends to the renderer (`browser.execute(script)`): a prelude that
 * defines the esbuild `__name` helper (a no-op), then the function applied to JSON-serialised
 * arguments. Specs must not rely on a bare `fn.toString()`: wdio's tsx loader compiles with
 * `keepNames`, and any named function expression or const-bound arrow would otherwise call a
 * helper the renderer does not have (Wave 2 review HIGH-1). The result is a function BODY (it
 * contains `return`), as the WebDriver execute command expects.
 */
export function serialiseForRenderer<A extends unknown[]>(
  fn: (...args: A) => unknown,
  ...args: A
): string {
  return `var __name=function(f){return f;};return (${fn.toString()}).apply(null, ${JSON.stringify(args)});`;
}

interface RendererDocument {
  hasFocus: () => boolean;
}

interface RendererWindow {
  Notification?: unknown;
  PerformanceObserver?: unknown;
  activeDocument?: RendererDocument;
  addEventListener?: (type: string, listener: (event: unknown) => void) => void;
  /** Obsidian's desktop renderer has Node's `require` on the window. */
  require?: (name: string) => unknown;
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
  // The constructible wrapper is returned from an immediately-invoked arrow instead of being
  // bound to a name: esbuild `keepNames` (wdio's tsx loader) rewrites a named function
  // expression to `__name(function ...)`, a helper that does not exist in the renderer.
  // biome-ignore lint/complexity/useArrowFunction: the wrapper is called with `new`, so it must be a constructible function, not an arrow.
  const Wrapper = (() =>
    function (title: string, options?: { body?: string; tag?: string }) {
      // The real constructor is never called: a native banner during an automated run is noise at
      // best (owner-run item 1 covers its appearance) and the windows that showed one died in
      // runs 6 to 10. The instance only retains the click handler.
      const instance: { onclick?: unknown } = { onclick: null };
      kept.push({
        instance,
        title: String(title),
        body: typeof options?.body === "string" ? options.body : null,
        tag: typeof options?.tag === "string" ? options.tag : null,
      });
      return instance;
    })() as unknown as typeof Original;
  Wrapper.prototype = Original.prototype;
  // Array elements are not a naming context, so esbuild keepNames leaves these arrows alone.
  const accessors = [
    () => Original.permission,
    (...args: unknown[]) => Original.requestPermission?.(...args),
  ];
  Object.defineProperty(Wrapper, "permission", {
    get: accessors[0] as () => string | undefined,
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(Wrapper, "requestPermission", {
    value: accessors[1],
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

// ---------------------------------------------------------------------------
// The save dialog (plan 08-20, D-12, T-08-51)

/** What the stubbed save dialog answers: a path the test chose, or a cancel. */
export type SaveDialogAnswer =
  | { readonly kind: "picked"; readonly path: string }
  | { readonly kind: "cancelled" };

/** What the stub recorded about one call: fixed fields only, never a title or a directory. */
export interface SaveDialogCall {
  readonly defaultPath: string | null;
  /** The default path is a bare file name: not empty and holding no folder separator. */
  readonly bareDefaultName: boolean;
  readonly filters: Array<{ name: string; extensions: string[] }>;
  readonly properties: string[];
}

interface RemoteDialogLike {
  showSaveDialog?: ((options?: unknown) => Promise<unknown>) | undefined;
}

/**
 * Replaces ONLY `showSaveDialog` of Electron's remote dialog, in this window, with a function that
 * records the options it is given and answers `answer` without opening anything. The real function
 * and the dialog object are kept in the spy namespace (so the remote proxy stays referenced) and
 * {@link restoreSaveDialog} puts the real one back. The runner cannot drive the native save sheet;
 * this is how the save path is exercised against a path inside the run root (never the vault).
 * A bad answer (not a cancel, or not an absolute `.json` path) installs nothing. Returns whether it
 * installed, and why not.
 */
export function installSaveDialogStub(answer: SaveDialogAnswer): {
  installed: boolean;
  reason: string | null;
} {
  const w = window as RendererWindow;
  const ns = w.__cccUatSpies ?? {};
  w.__cccUatSpies = ns;
  const valid =
    answer !== null &&
    typeof answer === "object" &&
    (answer.kind === "cancelled" ||
      (answer.kind === "picked" &&
        typeof answer.path === "string" &&
        answer.path.startsWith("/") &&
        answer.path.endsWith(".json")));
  if (!valid) return { installed: false, reason: "bad-answer" };
  if (ns["saveDialog"] !== undefined) return { installed: false, reason: "already-installed" };
  if (typeof w.require !== "function") return { installed: false, reason: "no-require" };
  let dialog: RemoteDialogLike | undefined;
  try {
    const electron = w.require("electron") as
      | { remote?: { dialog?: RemoteDialogLike } }
      | undefined;
    dialog = electron?.remote?.dialog;
  } catch {
    dialog = undefined;
  }
  if (dialog === undefined || typeof dialog.showSaveDialog !== "function") {
    return { installed: false, reason: "no-dialog" };
  }
  const original = dialog.showSaveDialog;
  const calls: SaveDialogCall[] = [];
  // Array elements are not a naming context, so esbuild keepNames leaves this arrow alone.
  const S = [
    (
      ...args: Array<{ defaultPath?: unknown; filters?: unknown; properties?: unknown } | undefined>
    ) => {
      // Electron's signature is showSaveDialog([window,] options): the options are the last
      // argument, whether or not the plugin named its own window first (FIX4B m8).
      const options = args[args.length - 1];
      const defaultPath = typeof options?.defaultPath === "string" ? options.defaultPath : null;
      const filters = Array.isArray(options?.filters)
        ? (options.filters as Array<{ name?: unknown; extensions?: unknown }>).map((entry) => ({
            name: String(entry?.name),
            extensions: Array.isArray(entry?.extensions) ? entry.extensions.map(String) : [],
          }))
        : [];
      const properties = Array.isArray(options?.properties)
        ? (options.properties as unknown[]).map(String)
        : [];
      calls.push({
        defaultPath,
        bareDefaultName: defaultPath !== null && defaultPath !== "" && !defaultPath.includes("/"),
        filters,
        properties,
      });
      return Promise.resolve(
        answer.kind === "picked" ? { canceled: false, filePath: answer.path } : { canceled: true },
      );
    },
  ];
  ns["saveDialog"] = { dialog, original, calls };
  dialog.showSaveDialog = S[0] as RemoteDialogLike["showSaveDialog"];
  return { installed: true, reason: null };
}

/** The calls the stub recorded since it was installed (a copy); empty when it is not installed. */
export function readSaveDialogCalls(): SaveDialogCall[] {
  const held = (window as RendererWindow).__cccUatSpies?.["saveDialog"] as
    | { calls: SaveDialogCall[] }
    | undefined;
  return held === undefined
    ? []
    : held.calls.map((call) => ({
        defaultPath: call.defaultPath,
        bareDefaultName: call.bareDefaultName,
        filters: call.filters.map((entry) => ({
          name: entry.name,
          extensions: [...entry.extensions],
        })),
        properties: [...call.properties],
      }));
}

/** Puts the real `showSaveDialog` back; false when the stub was not installed. */
export function restoreSaveDialog(): boolean {
  const ns = (window as RendererWindow).__cccUatSpies;
  const held = ns?.["saveDialog"] as
    | { dialog: RemoteDialogLike; original: RemoteDialogLike["showSaveDialog"] }
    | undefined;
  if (ns === undefined || held === undefined) return false;
  held.dialog.showSaveDialog = held.original;
  ns["saveDialog"] = undefined;
  return true;
}
