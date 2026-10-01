import yaml from "js-yaml";

/**
 * The runtime stand-in for the `obsidian` module under Vitest, wired up by
 * `packages/plugin/vitest.config.ts`'s `resolve.alias`.
 *
 * It exists because the `obsidian` npm package is types-only -- its
 * `package.json` declares `"main": ""` and ships nothing but `.d.ts` files,
 * since the real implementation is provided by the Obsidian application at
 * runtime and externalised from the bundle by `esbuild.config.mjs`. Any
 * plugin module that imports an obsidian VALUE (not just a type) therefore
 * cannot execute under a test runner without a stand-in.
 *
 * One aliased module, declared in one place, is deliberately preferred over
 * per-test `vi.mock("obsidian", ...)` calls: the same reason
 * {@link ./fake-obsidian-host.ts} exists rather than ad-hoc mocks. A single
 * double is reviewable, is shared by every test, and cannot drift
 * test-by-test.
 *
 * ## Why there is no `stringifyYaml` here
 *
 * There used to be, backed by js-yaml's `safeDump`, and the byte-parity
 * test leaned on it. The live-Obsidian UAT (2026-09-22) proved that
 * stand-in was WRONG: Obsidian's real `stringifyYaml` differs from js-yaml
 * in quote style, astral-plane escaping and number-like strings (GAP-1). A
 * stub cannot model a serializer whose options it cannot observe, so it no
 * longer pretends to -- the plugin serializes managed frontmatter through
 * its own bundled js-yaml (`../frontmatter-serializer.ts`) instead.
 *
 * Its ABSENCE is now a guard: production code that reaches back for
 * `stringifyYaml` fails at import time under Vitest, independently of the
 * source scans in `vault-write.test.ts` and
 * `frontmatter-serializer.test.ts`. Do not add it back.
 *
 * `parseYaml` stays, and is faithful for a different reason: it is a
 * PARSE, and both sides reach js-yaml's `safeLoad` (gray-matter's default
 * engine service-side). Its result is handed straight to a zod validation
 * before any field is read (threat T-02-08), so a parse difference would
 * surface as a refusal rather than as silently divergent bytes.
 */

/** Mirrors obsidian's `parseYaml(yaml: string): any`. */
export function parseYaml(input: string): unknown {
  return yaml.safeLoad(input);
}

/**
 * Stand-ins for the obsidian VALUES `setup-command.ts` constructs or
 * subclasses at module scope. Without them that module cannot even be
 * imported under Vitest, so `runVaultSetup` -- which touches none of
 * them -- would be untestable purely because its file neighbours do.
 *
 * Deliberately minimal and deliberately inert: no test in this repository
 * drives the modal through this stub, because a hand-written double of
 * Obsidian's DOM helpers would prove nothing about the real modal. The
 * modal's behaviour is covered by the live-Obsidian UAT; these exist only
 * so the module loads.
 */

/** The subset of Obsidian's element helpers the setup modal builds with. */
export interface StubElement {
  createEl(tag: string, options?: { text?: string }): StubElement;
  createDiv(): StubElement;
  addEventListener(type: string, handler: () => void): void;
  empty(): void;
}

function createStubElement(): StubElement {
  return {
    createEl: () => createStubElement(),
    createDiv: () => createStubElement(),
    addEventListener: () => {},
    empty: () => {},
  };
}

export class Notice {
  readonly message: string;

  constructor(message: string) {
    this.message = message;
  }
}

export class Modal {
  readonly app: unknown;
  contentEl: StubElement = createStubElement();

  constructor(app: unknown) {
    this.app = app;
  }

  open(): void {
    this.onOpen();
  }

  close(): void {
    this.onClose();
  }

  onOpen(): void {}

  onClose(): void {}
}

/**
 * Inert stand-ins for the settings-tab surface `view/settings-tab.ts`
 * subclasses and constructs at module scope (plan 03-04). Deliberately inert
 * for the same reason `Modal` is: a hand-written double of Obsidian's own
 * settings renderer would prove nothing about the real one, so the tab's
 * rendering is covered by the live-Obsidian UAT and its DECISION logic is
 * covered by `applyReducedMotionChange`, which touches none of this.
 */
export class PluginSettingTab {
  readonly app: unknown;
  readonly plugin: unknown;
  containerEl: StubElement = createStubElement();

  constructor(app: unknown, plugin: unknown) {
    this.app = app;
    this.plugin = plugin;
  }

  getSettingDefinitions(): unknown[] {
    return [];
  }

  getControlValue(_key: string): unknown {
    return undefined;
  }

  setControlValue(_key: string, _value: unknown): void {}

  update(): void {}

  hide(): void {}
}

/** The chainable builder, reduced to the calls that keep a chain legal. */
export class Setting {
  // biome-ignore lint/complexity/noUselessConstructor: mirrors Obsidian's `new Setting(containerEl)` signature so stubbed callers type-check the same way.
  constructor(_containerEl: unknown) {}

  setName(_name: string | DocumentFragment): this {
    return this;
  }

  setDesc(_desc: string | DocumentFragment): this {
    return this;
  }

  addDropdown(cb: (component: StubDropdown) => unknown): this {
    cb(createStubDropdown());
    return this;
  }

  addToggle(cb: (component: StubToggle) => unknown): this {
    cb({ setValue: () => createStubToggle(), onChange: () => createStubToggle() });
    return this;
  }
}

export interface StubDropdown {
  addOption(value: string, display: string): StubDropdown;
  setValue(value: string): StubDropdown;
  onChange(handler: (value: string) => unknown): StubDropdown;
}

export interface StubToggle {
  setValue(value: boolean): StubToggle;
  onChange(handler: (value: boolean) => unknown): StubToggle;
}

function createStubDropdown(): StubDropdown {
  const dropdown: StubDropdown = {
    addOption: () => dropdown,
    setValue: () => dropdown,
    onChange: () => dropdown,
  };
  return dropdown;
}

function createStubToggle(): StubToggle {
  const toggle: StubToggle = {
    setValue: () => toggle,
    onChange: () => toggle,
  };
  return toggle;
}

/**
 * Mirrors obsidian's `normalizePath` closely enough for a path-shape test:
 * collapses duplicate separators and trims a trailing one. Plan 03-08 needs
 * it; like every other value here, the real behaviour is Obsidian's.
 */
export function normalizePath(path: string): string {
  return (
    path
      .replace(/\\/g, "/")
      .replace(/\/{2,}/g, "/")
      .replace(/\/+$/, "") || "/"
  );
}

/** Obsidian draws the icon; under test there is nothing to draw. */
export function setIcon(_element: unknown, _iconId: string): void {}

export class FileSystemAdapter {
  private readonly basePath: string;

  constructor(basePath = "") {
    this.basePath = basePath;
  }

  getBasePath(): string {
    return this.basePath;
  }
}

/**
 * Inert stand-ins for the quick-switcher surface (`view/quick-switcher.ts`,
 * plan 04-05 SC-5). The real `SuggestModal`/`FuzzySuggestModal` render a
 * search UI and drive keyboard selection through Obsidian's own internals —
 * none of that is reproducible here, so like `Modal` these exist only so a
 * module that subclasses them loads under Vitest. `command-center-view.ts`'s
 * `Mod+K` binding is tested through `registerSwitcherScope`, a pure function
 * that touches none of this (SC-5).
 */
export class SuggestModal<T> extends Modal {
  limit = 100;
  emptyStateText = "No matches found";
  /**
   * A real (jsdom) input, so a prefill that sets `value` and dispatches an
   * `input` event — the way Obsidian's own modal re-runs its search — is
   * observable under test (plan 04-14).
   */
  inputEl: HTMLInputElement = document.createElement("input");
  resultContainerEl: StubElement = createStubElement();
  /** Recorded, not rendered: what `setPlaceholder` and `setInstructions` were given. */
  placeholder = "";
  instructions: unknown[] = [];

  setPlaceholder(placeholder: string): void {
    this.placeholder = placeholder;
  }

  setInstructions(instructions: unknown[]): void {
    this.instructions = instructions;
  }

  onNoSuggestion(): void {}

  selectSuggestion(_value: T, _evt: MouseEvent | KeyboardEvent): void {}

  selectActiveSuggestion(_evt: MouseEvent | KeyboardEvent): void {}
}

export abstract class FuzzySuggestModal<T> extends SuggestModal<{ item: T; match: unknown }> {
  abstract getItems(): T[];
  abstract getItemText(item: T): string;
  abstract onChooseItem(item: T, evt: MouseEvent | KeyboardEvent): void;

  getSuggestions(_query: string): { item: T; match: unknown }[] {
    return [];
  }

  renderSuggestion(_item: { item: T; match: unknown }, _el: unknown): void {}

  onChooseSuggestion(match: { item: T; match: unknown }, evt: MouseEvent | KeyboardEvent): void {
    this.onChooseItem(match.item, evt);
  }
}

/**
 * Records every `register()` call rather than reproducing Obsidian's real
 * hotkey dispatch — a plugin module constructs a `Scope` and registers a
 * binding on it (`command-center-view.ts`'s `Mod+K`), and this stub proves
 * only that the registration happened, in the same inert style as `Modal`.
 */
export interface RecordedRegistration {
  readonly modifiers: readonly string[] | null;
  readonly key: string | null;
  readonly func: (...args: unknown[]) => unknown;
}

export class Scope {
  readonly registrations: RecordedRegistration[] = [];

  // biome-ignore lint/complexity/noUselessConstructor: mirrors Obsidian's `new Scope(parent?)` signature so stubbed callers type-check the same way.
  constructor(_parent?: Scope) {}

  register(
    modifiers: string[] | null,
    key: string | null,
    func: (...args: unknown[]) => unknown,
  ): RecordedRegistration {
    const registration: RecordedRegistration = { modifiers, key, func };
    this.registrations.push(registration);
    return registration;
  }

  unregister(handler: RecordedRegistration): void {
    const index = this.registrations.indexOf(handler);
    if (index >= 0) this.registrations.splice(index, 1);
  }
}

/**
 * A simple case-insensitive subsequence scorer — faithful enough for a
 * shape test (does a query's characters appear in order), not Obsidian's
 * real fuzzy-match ranking, which lives entirely in the host application.
 */
export function prepareFuzzySearch(query: string): (text: string) => { score: number } | null {
  const needle = query.toLowerCase();
  return (text: string) => {
    const haystack = text.toLowerCase();
    let index = 0;
    for (const char of needle) {
      const found = haystack.indexOf(char, index);
      if (found === -1) return null;
      index = found + 1;
    }
    return { score: -needle.length };
  };
}
