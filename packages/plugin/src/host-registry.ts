import type { Events, Plugin, ViewCreator } from "obsidian";

/**
 * The single seam every listener, interval, DOM handler, view, ribbon
 * icon, and command in this plugin goes through (PLUG-03, PLUG-05).
 * Obsidian's own `register*` helpers already sweep their own registration
 * on unload -- the registry exists so that completeness is *observable*:
 * without a single seam there is no way to assert that nothing was
 * registered outside that sweep, and a listener registered directly on a
 * DOM node or a third-party emitter is exactly the leak that would escape
 * it. See `lifecycle.test.ts` for the twenty-cycle proof against
 * {@link FakeObsidianHost}.
 */

export type Disposer = () => void;

export interface DomTargetLike {
  addEventListener(type: string, handler: (ev: unknown) => void): void;
  removeEventListener(type: string, handler: (ev: unknown) => void): void;
}

export interface CommandLike {
  id: string;
  name: string;
  callback: () => void;
}

/**
 * The subset of the Obsidian plugin host surface this plugin touches. Each
 * method both performs the real registration *and* returns a {@link Disposer}
 * for the registry's own bookkeeping -- see {@link createObsidianHost} for
 * how the real Obsidian `Plugin` (whose own `register*` methods return
 * `void`, not a disposer) is adapted to this shape.
 */
export interface RegistrationHost {
  registerEvent(name: string, handler: (payload?: unknown) => void): Disposer;
  registerInterval(callback: () => void, ms: number): Disposer;
  registerDomEvent(target: DomTargetLike, type: string, handler: (ev: unknown) => void): Disposer;
  registerView(type: string, factory: (leaf: never) => unknown): Disposer;
  addRibbonIcon(icon: string, title: string, callback: () => void): Disposer;
  addCommand(command: CommandLike): Disposer;
}

export interface DisposalFailure {
  error: unknown;
}

export interface HostRegistry {
  event(name: string, handler: (payload?: unknown) => void): void;
  interval(callback: () => void, ms: number): void;
  domEvent(target: DomTargetLike, type: string, handler: (ev: unknown) => void): void;
  view(type: string, factory: (leaf: never) => unknown): void;
  ribbon(icon: string, title: string, callback: () => void): void;
  command(cmd: CommandLike): void;
  /**
   * Removes every live registration, calling each underlying disposer
   * exactly once in total across however many times `disposeAll()` itself
   * is called. A disposer that throws is collected as a failure rather
   * than aborting the remaining disposal.
   */
  disposeAll(): DisposalFailure[];
  /** The total number of currently-live registrations, across every kind. */
  liveCount(): number;
  /**
   * The generic registration primitive every named method above delegates
   * to. Exposed directly so a future registration kind not yet covered by
   * a named method is still routed through the same completeness
   * guarantee, and so an unrecognized kind fails loudly in development
   * rather than silently leaking.
   */
  registerRaw(kind: string, dispose: Disposer): void;
}

const KNOWN_KINDS = ["event", "interval", "domEvent", "view", "ribbon", "command"] as const;
type KnownKind = (typeof KNOWN_KINDS)[number];

function isKnownKind(kind: string): kind is KnownKind {
  return (KNOWN_KINDS as readonly string[]).includes(kind);
}

export function createHostRegistry(host: RegistrationHost): HostRegistry {
  const disposers: Disposer[] = [];

  function registerRaw(kind: string, dispose: Disposer): void {
    if (!isKnownKind(kind)) {
      throw new Error(
        `host-registry: unknown registration kind "${kind}" has no disposer defined -- ` +
          `add it to KNOWN_KINDS and a named HostRegistry method before using it, so unload ` +
          `completeness stays provable rather than silently leaking.`,
      );
    }
    disposers.push(dispose);
  }

  return {
    event(name, handler) {
      registerRaw("event", host.registerEvent(name, handler));
    },
    interval(callback, ms) {
      registerRaw("interval", host.registerInterval(callback, ms));
    },
    domEvent(target, type, handler) {
      registerRaw("domEvent", host.registerDomEvent(target, type, handler));
    },
    view(type, factory) {
      registerRaw("view", host.registerView(type, factory));
    },
    ribbon(icon, title, callback) {
      registerRaw("ribbon", host.addRibbonIcon(icon, title, callback));
    },
    command(cmd) {
      registerRaw("command", host.addCommand(cmd));
    },
    registerRaw,
    disposeAll(): DisposalFailure[] {
      // splice (not a for-of over the live array) makes a second call see
      // an already-empty array -- idempotency by construction, not by a
      // separate "already disposed" flag.
      const pending = disposers.splice(0, disposers.length);
      const failures: DisposalFailure[] = [];
      for (const dispose of pending) {
        try {
          dispose();
        } catch (error) {
          failures.push({ error });
        }
      }
      return failures;
    },
    liveCount(): number {
      return disposers.length;
    },
  };
}

/**
 * The production adapter: wraps a real Obsidian `Plugin` instance so its
 * `register*` calls satisfy {@link RegistrationHost}. Obsidian's own
 * internal cleanup (via `Component.register()`, which every one of these
 * methods already uses under the hood) is what actually undoes the
 * registration on unload -- the disposer returned here exists purely so
 * `createHostRegistry`'s own `liveCount()`/`disposeAll()` bookkeeping stays
 * in lockstep with `onunload()`, which is the same moment Obsidian's own
 * sweep runs.
 */
export function createObsidianHost(plugin: Plugin): RegistrationHost {
  return {
    registerEvent(name, handler) {
      // `Workspace` (which `plugin.app.workspace` is) redeclares `on()` with
      // its own set of named-event overloads, which shadows the generic
      // `Events.on(name: string, ...)` overload this adapter needs for an
      // arbitrary event name -- casting to the `Events` base restores it.
      const ref = (plugin.app.workspace as Events).on(name, handler);
      plugin.registerEvent(ref);
      return () => {};
    },
    registerInterval(callback, ms) {
      const id = window.setInterval(callback, ms);
      plugin.registerInterval(id);
      return () => {};
    },
    registerDomEvent(target, type, handler) {
      // `registerDomEvent`'s real type is an overload set keyed by
      // `keyof {Window,Document,HTMLElement}EventMap`, which a plain
      // `string` can never satisfy through argument casts alone -- calling
      // through a locally-typed arrow function (rather than grabbing
      // `plugin.registerDomEvent` as an unbound method reference)
      // simplifies the signature without the `@typescript-eslint/unbound-method`
      // footgun. Unused by `main.ts` today (no event registration in this
      // phase's shell); kept type-correct for whichever future
      // registration is the first to need it.
      const register: (el: HTMLElement, type: string, callback: (ev: unknown) => unknown) => void =
        (el, t, cb) => {
          plugin.registerDomEvent(el, t as "click", cb);
        };
      register(target as unknown as HTMLElement, type, handler);
      return () => {};
    },
    registerView(type, factory) {
      plugin.registerView(type, factory as unknown as ViewCreator);
      return () => {};
    },
    addRibbonIcon(icon, title, callback) {
      plugin.addRibbonIcon(icon, title, callback);
      return () => {};
    },
    addCommand(command) {
      plugin.addCommand(command);
      return () => {};
    },
  };
}
