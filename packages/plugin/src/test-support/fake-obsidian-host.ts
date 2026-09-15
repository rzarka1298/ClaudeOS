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
