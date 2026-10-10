import type { Events, Plugin, PluginSettingTab, ViewCreator } from "obsidian";

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

/**
 * What an `obsidian://` URL carries for a registered action: a flat map of
 * decoded query values (plus the action itself). The registry types it as
 * strings, but a handler MUST NOT trust that -- the URL is attacker-controlled.
 */
export type ProtocolParams = Readonly<Record<string, string>>;

/**
 * A single reusable one-shot timer. Scheduling again REPLACES the pending
 * callback, so a slot is one registration however often it is used, and a
 * disposed slot is inert (a late `schedule` after unload does nothing).
 */
export interface TimerSlot {
  schedule(callback: () => void, ms: number): void;
  cancel(): void;
}

/** A {@link TimerSlot} plus the disposer the registry owns. */
export interface TimerRegistration {
  readonly slot: TimerSlot;
  readonly dispose: Disposer;
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
  addSettingTab(tab: unknown): Disposer;
  /** A `obsidian://<action>` handler (plan 06-09, D-26). Throws if the action is already registered. */
  registerProtocolHandler(action: string, handler: (params: ProtocolParams) => void): Disposer;
  /**
   * A vault event (`create`, `modify`, `delete`, `rename`). The host defers the
   * subscription until the workspace layout is ready, so existing files do not
   * replay as `create` events at startup (A-10, Pitfall 7).
   */
  registerVaultEvent(name: string, handler: (payload?: unknown) => void): Disposer;
  /** One reusable timer slot whose pending callback cannot outlive unload. */
  registerTimer(): TimerRegistration;
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
   * The plugin's Settings tab (plan 03-04). Obsidian's own unload sweep is
   * what actually removes it; the disposer exists so `liveCount()` stays in
   * lockstep with `onunload()`, exactly like every other kind here.
   */
  settingTab(tab: unknown): void;
  /**
   * The quick-switcher's own launch requester (plan 04-14): `dispose` clears
   * its pending 5 s deadlines and 6 s success clears and makes a late
   * answer or a late choice inert. Not an Obsidian host method, so the
   * disposer is the caller's own (wave-7 finding 2).
   */
  launchTimers(dispose: Disposer): void;
  /** Closes a quick-switcher modal still open when the plugin unloads (wave-7 finding 2). */
  switcherModal(dispose: Disposer): void;
  /**
   * An `obsidian://` protocol handler (plan 06-09, D-26). Not wrapped: a
   * duplicate-action throw from the host propagates to the caller, which
   * decides what to do (see `registerApprovalProtocol`).
   */
  protocolHandler(action: string, handler: (params: ProtocolParams) => void): void;
  /** A vault event, subscribed only once the layout is ready (A-10). */
  vaultEvent(name: string, handler: (payload?: unknown) => void): void;
  /** A timer slot; one registration however often it is scheduled. */
  timer(): TimerSlot;
  /**
   * Teardown that is not an Obsidian registration: a signal effect, a
   * module-level hook, an open modal. Counted so the 20-cycle test sees it.
   */
  cleanup(dispose: Disposer): void;
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

/**
 * `eventStream` is not an Obsidian host method at all -- it is
 * `@ccc/service-api-client`'s `EventClient.dispose()` (plan 01-06), routed
 * through `registerRaw` directly rather than a named `RegistrationHost`
 * method, exactly the "future registration kind not yet covered by a named
 * method" case `registerRaw`'s own doc comment anticipates.
 */
const KNOWN_KINDS = [
  "event",
  "interval",
  "domEvent",
  "view",
  "ribbon",
  "command",
  "settingTab",
  "eventStream",
  // The quick-switcher's launch requester (plan 04-14): its pending
  // `window.setTimeout` deadlines, cleared on unload like the view's own.
  "launchTimers",
  // A quick-switcher modal still open at unload (wave-7 finding 2).
  "switcherModal",
  // Plan 06-09: the approval deep link, vault events (deferred to layout-ready),
  // a reusable timer slot, and teardown that is not an Obsidian registration.
  "protocolHandler",
  "vaultEvent",
  "timer",
  "cleanup",
] as const;
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
    settingTab(tab) {
      registerRaw("settingTab", host.addSettingTab(tab));
    },
    launchTimers(dispose) {
      registerRaw("launchTimers", dispose);
    },
    switcherModal(dispose) {
      registerRaw("switcherModal", dispose);
    },
    protocolHandler(action, handler) {
      registerRaw("protocolHandler", host.registerProtocolHandler(action, handler));
    },
    vaultEvent(name, handler) {
      registerRaw("vaultEvent", host.registerVaultEvent(name, handler));
    },
    timer() {
      const { slot, dispose } = host.registerTimer();
      registerRaw("timer", dispose);
      return slot;
    },
    cleanup(dispose) {
      registerRaw("cleanup", dispose);
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
 * A {@link TimerSlot} over an injected one-shot timer, with a `dispose` that
 * cancels any pending callback and makes later scheduling inert. Shared by the
 * Obsidian adapter (real `window.setTimeout`) and any host that supplies its
 * own clock, so the replace-on-schedule and inert-after-dispose rules are
 * written once.
 */
export function createTimerSlot<Handle>(timers: {
  set: (callback: () => void, ms: number) => Handle;
  clear: (handle: Handle) => void;
}): TimerSlot & { dispose: Disposer } {
  let pending: { handle: Handle } | null = null;
  let disposed = false;
  const cancel = (): void => {
    if (pending !== null) {
      timers.clear(pending.handle);
      pending = null;
    }
  };
  return {
    schedule(callback, ms) {
      if (disposed) return;
      cancel();
      const entry: { handle: Handle } = {
        handle: timers.set(() => {
          if (pending === entry) pending = null;
          callback();
        }, ms),
      };
      pending = entry;
    },
    cancel,
    dispose() {
      disposed = true;
      cancel();
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
    addSettingTab(tab) {
      plugin.addSettingTab(tab as PluginSettingTab);
      return () => {};
    },
    registerProtocolHandler(action, handler) {
      // Obsidian registers its own unregister callback on the plugin, so the
      // unload sweep removes the action; the disposer exists only for the
      // registry's bookkeeping (research spike S8). A duplicate action THROWS
      // from here, deliberately uncaught -- the caller owns that policy.
      plugin.registerObsidianProtocolHandler(action, handler);
      return () => {};
    },
    registerVaultEvent(name, handler) {
      // The one place vault events are subscribed (A-10): inside
      // `onLayoutReady`, so the existing files do not replay as `create`
      // events at startup. A registration disposed before the layout is ready
      // never subscribes; one disposed after unsubscribes through `offref`.
      let disposed = false;
      let ref: ReturnType<Events["on"]> | null = null;
      plugin.app.workspace.onLayoutReady(() => {
        if (disposed) return;
        // `Vault` redeclares `on()` with named-event overloads; the `Events`
        // base restores the generic string overload this adapter needs.
        ref = (plugin.app.vault as Events).on(name, handler);
        plugin.registerEvent(ref);
      });
      return () => {
        disposed = true;
        if (ref !== null) {
          plugin.app.vault.offref(ref);
          ref = null;
        }
      };
    },
    registerTimer() {
      const slot = createTimerSlot<number>({
        set: (callback, ms) => window.setTimeout(callback, ms),
        clear: (handle) => {
          window.clearTimeout(handle);
        },
      });
      // Obsidian's own unload sweep also cancels it, so a pending timer cannot
      // outlive the plugin even if the registry is never disposed.
      plugin.register(() => slot.dispose());
      return { slot, dispose: () => slot.dispose() };
    },
  };
}
