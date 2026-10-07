/**
 * A test double of the Obsidian plugin host surface this plugin touches --
 * not a reimplementation of the `obsidian` package's types, but a minimal,
 * purpose-built fake whose only job is to make "nothing leaked across N
 * load/unload cycles" an assertable fact (PLUG-03, PLUG-05). Its
 * `liveCounts()` breakdown and `fireWorkspaceEvent()` are exactly the
 * PITFALLS.md unload-leak technique: dispatch N events, count invocations,
 * rather than trust that disposal "probably" happened.
 */

export type Disposer = () => void;

/**
 * The minimal file handle `FakeVault.process()` accepts, matching the one
 * property `vault-write.ts` reads off a real `TFile`. Deliberately NOT a
 * cast of the real `TFile` class: constructing one would mean reaching into
 * the `obsidian` runtime (which ships types only) or casting an object
 * literal, and the plugin skill's rule 2 forbids unsafe `TFile` casts.
 */
export interface FakeFile {
  readonly path: string;
}

/**
 * An in-memory stand-in for the one Obsidian `Vault` method the managed-note
 * write path uses, `process()` -- the same fake-host technique
 * {@link FakeObsidianHost} applies to the registration surface, applied to
 * the write surface.
 *
 * Two pieces of bookkeeping exist so VAULT-06 claims are assertable rather
 * than assumed: {@link processCallCount} makes "exactly one process() call
 * per invocation, never a silent retry" a counted fact, and
 * {@link writtenPaths} makes "this module writes the note and nothing else --
 * never an index.md" a recorded fact. Like the real `Vault.process`, a write
 * is recorded on every call, including one whose callback returns the
 * content unchanged.
 */
export class FakeVault {
  private readonly contents = new Map<string, string>();

  /** Number of `process()` invocations since construction. */
  processCallCount = 0;

  /** Every path `process()` wrote, in call order (duplicates kept). */
  readonly writtenPaths: string[] = [];

  constructor(initial: Readonly<Record<string, string>> = {}) {
    for (const [path, content] of Object.entries(initial)) {
      this.contents.set(path, content);
    }
  }

  /** A handle for `path`, whether or not the fake currently holds content for it. */
  file(path: string): FakeFile {
    return { path };
  }

  /** The current on-"disk" content at `path`. Throws for an unknown path. */
  read(path: string): string {
    const current = this.contents.get(path);
    if (current === undefined) {
      throw new Error(`fake vault: no file at ${path}`);
    }
    return current;
  }

  /** Replaces the content at `path` without going through `process()` -- the fake's way of staging a concurrent external edit. */
  setExternally(path: string, content: string): void {
    this.contents.set(path, content);
  }

  /**
   * Mirrors `Vault.process(file, fn)`: reads the current content, hands it
   * to the synchronous callback, persists the callback's return value, and
   * resolves with what was written.
   */
  async process(file: FakeFile, fn: (data: string) => string): Promise<string> {
    this.processCallCount++;
    const next = fn(this.read(file.path));
    this.contents.set(file.path, next);
    this.writtenPaths.push(file.path);
    return next;
  }
}

/** The `Stat` shape Obsidian's `DataAdapter.stat()` resolves with. */
export interface FakeStat {
  readonly type: "file" | "folder";
  readonly ctime: number;
  readonly mtime: number;
  readonly size: number;
}

/**
 * An in-memory stand-in for the two `DataAdapter` methods the layout-file
 * poller uses, `stat()` and `read()` -- the {@link FakeVault} technique applied
 * to the plugin data folder, which vault events do not cover (plan 03-08).
 *
 * It holds ONE file, because the poller only ever asks about one path, and it
 * records the path of every call so a test can prove the poller asked about
 * the right one. The two counters make the poller's cost claims assertable
 * rather than assumed: {@link statCallCount} makes "one stat per interval" a
 * counted fact, and {@link readCallCount} makes "re-read only when the file
 * changed" a counted fact.
 *
 * `stat()` and `read()` can be held open with {@link holdNextStat}, so a test
 * can overlap two ticks against one slow stat.
 */
export class FakeDataAdapter {
  private file: { content: string; mtime: number; size: number } | null = null;
  private heldStat: Promise<void> | null = null;

  /** Number of `stat()` invocations since construction. */
  statCallCount = 0;

  /** Number of `read()` invocations since construction. */
  readCallCount = 0;

  /** Every path `stat()` or `read()` was asked about, in call order. */
  readonly requestedPaths: string[] = [];

  /**
   * Replaces the file, the way an editor save or an atomic rename would.
   * `size` is the UTF-8 byte length, as a real filesystem reports it.
   */
  setFile(content: string, mtime: number): void {
    this.file = { content, mtime, size: new TextEncoder().encode(content).byteLength };
  }

  /** Deletes the file. */
  remove(): void {
    this.file = null;
  }

  /**
   * Makes the next `stat()` wait until the returned function is called --
   * the fake's way of staging a slow disk.
   */
  holdNextStat(): () => void {
    let release: () => void = () => {};
    this.heldStat = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }

  /** Mirrors `DataAdapter.stat()`: the file's stat, or `null` when absent. */
  async stat(path: string): Promise<FakeStat | null> {
    this.statCallCount++;
    this.requestedPaths.push(path);
    const held = this.heldStat;
    this.heldStat = null;
    if (held !== null) await held;
    if (this.file === null) return null;
    return { type: "file", ctime: 0, mtime: this.file.mtime, size: this.file.size };
  }

  /** Mirrors `DataAdapter.read()`: the file's text. Throws when absent. */
  async read(path: string): Promise<string> {
    this.readCallCount++;
    this.requestedPaths.push(path);
    if (this.file === null) {
      throw new Error(`fake data adapter: no file at ${path}`);
    }
    return this.file.content;
  }
}

export interface LiveCounts {
  event: number;
  interval: number;
  domEvent: number;
  view: number;
  ribbon: number;
  command: number;
  settingTab: number;
  protocolHandler: number;
  vaultEvent: number;
  timer: number;
}

/** The protocol handler shape the fake records; params are a flat string map like Obsidian's. */
export type FakeProtocolHandler = (params: Readonly<Record<string, string>>) => void;

/** A manually-driven timer slot: nothing fires until the test calls {@link FakeObsidianHost.fireTimers}. */
interface FakeTimerRegistration {
  slot: { schedule(callback: () => void, ms: number): void; cancel(): void };
  dispose: Disposer;
}

export interface CommandLike {
  id: string;
  name: string;
  callback: () => void;
}

export interface EventTargetLike {
  addEventListener(type: string, handler: (ev: unknown) => void): void;
  removeEventListener(type: string, handler: (ev: unknown) => void): void;
}

/** A minimal fake DOM target for `registerDomEvent` tests -- not tied to jsdom. */
export function createFakeDomTarget(): EventTargetLike {
  const listeners = new Map<string, Set<(ev: unknown) => void>>();
  return {
    addEventListener(type, handler) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
  };
}

export class FakeWorkspaceLeaf {
  viewType: string | null = null;
  revealed = false;

  async setViewState(state: { type: string; active: boolean }): Promise<void> {
    this.viewType = state.type;
  }
}

export class FakeObsidianHost {
  private readonly eventHandlers = new Map<string, Set<(payload?: unknown) => void>>();
  private intervalCount = 0;
  private domEventCount = 0;
  private readonly viewTypes = new Map<string, unknown>();
  private ribbonCount = 0;
  private readonly commandIds = new Set<string>();
  private settingTabCount = 0;
  private readonly protocolHandlers = new Map<string, FakeProtocolHandler>();
  /** Every vault-event registration, live or not yet delivered; `active` flips at layout-ready. */
  private readonly vaultEvents = new Set<{
    name: string;
    handler: (payload?: unknown) => void;
    active: boolean;
  }>();
  private layoutReady = false;
  private readonly timers = new Set<{ pending: (() => void) | null }>();
  private data: unknown = null;
  private readonly leaves: FakeWorkspaceLeaf[] = [];

  /** Incremented on every `saveData` call -- proves "save invoked at most once per cycle" rather than assuming it. */
  saveDataCallCount = 0;

  // ---- registration surface (mirrors the real Obsidian method names) ----

  registerEvent(name: string, handler: (payload?: unknown) => void): Disposer {
    let set = this.eventHandlers.get(name);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(name, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  registerInterval(_callback: () => void, _ms: number): Disposer {
    this.intervalCount++;
    return () => {
      this.intervalCount--;
    };
  }

  registerDomEvent(
    target: EventTargetLike,
    type: string,
    handler: (ev: unknown) => void,
  ): Disposer {
    target.addEventListener(type, handler);
    this.domEventCount++;
    return () => {
      target.removeEventListener(type, handler);
      this.domEventCount--;
    };
  }

  registerView(type: string, factory: unknown): Disposer {
    this.viewTypes.set(type, factory);
    return () => {
      this.viewTypes.delete(type);
    };
  }

  addRibbonIcon(_icon: string, _title: string, _callback: () => void): Disposer {
    this.ribbonCount++;
    return () => {
      this.ribbonCount--;
    };
  }

  addCommand(command: CommandLike): Disposer {
    this.commandIds.add(command.id);
    return () => {
      this.commandIds.delete(command.id);
    };
  }

  addSettingTab(_tab: unknown): Disposer {
    this.settingTabCount++;
    return () => {
      this.settingTabCount--;
    };
  }

  /**
   * Mirrors `plugin.registerObsidianProtocolHandler`: Obsidian's own registry
   * THROWS on a duplicate action (research spike S8), so a missing unregister
   * is a red test here, not a silent no-op.
   */
  registerProtocolHandler(action: string, handler: FakeProtocolHandler): Disposer {
    if (this.protocolHandlers.has(action)) {
      throw new Error(`Action "${action}" is already registered as a handler.`);
    }
    this.protocolHandlers.set(action, handler);
    return () => {
      if (this.protocolHandlers.get(action) === handler) this.protocolHandlers.delete(action);
    };
  }

  /**
   * Mirrors the adapter's `onLayoutReady`-deferred `vault.on`: a registration
   * made before the layout is ready receives nothing until {@link setLayoutReady};
   * one disposed before then never activates at all (A-10, Pitfall 7).
   */
  registerVaultEvent(name: string, handler: (payload?: unknown) => void): Disposer {
    const entry = { name, handler, active: this.layoutReady };
    this.vaultEvents.add(entry);
    return () => {
      this.vaultEvents.delete(entry);
    };
  }

  /** Mirrors `workspace.onLayoutReady` firing: queued vault events become live. */
  setLayoutReady(): void {
    this.layoutReady = true;
    for (const entry of this.vaultEvents) entry.active = true;
  }

  /** Delivers a vault event to every ACTIVE handler for `name`. */
  emitVaultEvent(name: string, payload?: unknown, ...rest: unknown[]): void {
    for (const entry of [...this.vaultEvents]) {
      // Obsidian's `rename` event also carries the old path; the registry types the handler
      // with one parameter, so the extras are passed through an untyped call.
      if (entry.active && entry.name === name) {
        (entry.handler as (...args: unknown[]) => void)(payload, ...rest);
      }
    }
  }

  /** Mirrors a protocol URL arriving for `action`. Returns false when nothing is registered. */
  fireProtocol(action: string, params: Readonly<Record<string, string>>): boolean {
    const handler = this.protocolHandlers.get(action);
    if (handler === undefined) return false;
    handler(params);
    return true;
  }

  registerTimer(): FakeTimerRegistration {
    const entry: { pending: (() => void) | null } = { pending: null };
    this.timers.add(entry);
    return {
      slot: {
        schedule: (callback) => {
          entry.pending = callback;
        },
        cancel: () => {
          entry.pending = null;
        },
      },
      dispose: () => {
        entry.pending = null;
        this.timers.delete(entry);
      },
    };
  }

  /** Runs every pending timer callback once (clearing it first), as a test's manual clock. */
  fireTimers(): void {
    for (const entry of [...this.timers]) {
      const callback = entry.pending;
      entry.pending = null;
      callback?.();
    }
  }

  // ---- event bus (mirrors `workspace.on`/`fireWorkspaceEvent` for the leak test) ----

  fireWorkspaceEvent(name: string, payload?: unknown): void {
    const set = this.eventHandlers.get(name);
    if (!set) return;
    // Snapshot before iterating: a handler that unregisters itself mid-fire
    // must not change how many of the handlers already live get invoked.
    for (const handler of [...set]) handler(payload);
  }

  // ---- data persistence (mirrors Plugin.loadData/saveData) ----

  async loadData(): Promise<unknown> {
    return this.data;
  }

  async saveData(value: unknown): Promise<void> {
    this.saveDataCallCount++;
    this.data = value;
  }

  // ---- workspace navigation (mirrors app.workspace.*) ----

  getLeavesOfType(type: string): FakeWorkspaceLeaf[] {
    return this.leaves.filter((leaf) => leaf.viewType === type);
  }

  getRightLeaf(_split: boolean): FakeWorkspaceLeaf {
    const leaf = new FakeWorkspaceLeaf();
    this.leaves.push(leaf);
    return leaf;
  }

  async revealLeaf(leaf: FakeWorkspaceLeaf): Promise<void> {
    leaf.revealed = true;
  }

  // ---- introspection for tests ----

  liveCounts(): LiveCounts {
    let event = 0;
    for (const set of this.eventHandlers.values()) event += set.size;
    return {
      event,
      interval: this.intervalCount,
      domEvent: this.domEventCount,
      view: this.viewTypes.size,
      ribbon: this.ribbonCount,
      command: this.commandIds.size,
      settingTab: this.settingTabCount,
      protocolHandler: this.protocolHandlers.size,
      vaultEvent: this.vaultEvents.size,
      timer: this.timers.size,
    };
  }
}
