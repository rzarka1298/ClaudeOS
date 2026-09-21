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

export interface LiveCounts {
  event: number;
  interval: number;
  domEvent: number;
  view: number;
  ribbon: number;
  command: number;
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
    };
  }
}
