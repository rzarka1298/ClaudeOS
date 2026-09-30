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
  /** Mirrors Obsidian's `Element.setText` DOM extension -- inert (plan 05-07). */
  setText(text: string): void;
  /** Mirrors the real `titleEl`/`buttonEl`'s native `HTMLElement.focus` -- inert. */
  focus(): void;
  /** Added wave 5 review (ids, `aria-describedby`, `<label for>` on the session modals) -- inert. */
  setAttribute(name: string, value: string): void;
}

function createStubElement(): StubElement {
  return {
    createEl: () => createStubElement(),
    createDiv: () => createStubElement(),
    addEventListener: () => {},
    empty: () => {},
    setText: () => {},
    focus: () => {},
    setAttribute: () => {},
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
  /** Added plan 05-07 (delete-usage modal); every other modal in this file predates it. */
  titleEl: StubElement = createStubElement();

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
 * Inert stand-in for Obsidian's `ButtonComponent` (plan 05-07, delete-usage
 * modal). Deliberately minimal, same rationale as `Modal`/`PluginSettingTab`
 * above: `setCta`/`setDestructive`/`setButtonText` are no-ops that return
 * `this` for chaining, and `onClick` does not wire a real DOM listener --
 * the modal's OWN `confirm()`/`close()` methods are what a test calls
 * directly, never a simulated click through this stub.
 */
export class ButtonComponent {
  buttonEl: StubElement = createStubElement();

  constructor(_containerEl: StubElement) {}

  setButtonText(_text: string): this {
    return this;
  }

  setCta(): this {
    return this;
  }

  setDestructive(): this {
    return this;
  }

  /** Added plan 05-15 (session-modals.ts's worktree-step Launch button) -- inert, same rationale as every other setter here. */
  setDisabled(_disabled: boolean): this {
    return this;
  }

  onClick(_handler: (evt: MouseEvent) => unknown): this {
    return this;
  }
}

/** Mirrors obsidian's `Instruction` (`{ command, purpose }`) closely enough for a shape test. */
export interface StubInstruction {
  command: string;
  purpose: string;
}

/**
 * Inert stand-in for Obsidian's `FuzzySuggestModal<T>` (plan 05-15, the
 * associate-with-project picker). Same rationale as `Modal`/`ButtonComponent`
 * above: `setPlaceholder`/`setInstructions` just record what they were given
 * so a test can read it back, and `getItems`/`getItemText`/`onChooseItem` are
 * the subclass's own overrides -- this stub supplies no fuzzy-search
 * behaviour of its own, because a hand-written one would prove nothing about
 * Obsidian's real matcher. Base check before adding: absent from this file
 * until this plan; shared with the Phase 4 project palette (05-UI-SPEC R-01),
 * which needed the same class and did not land here first.
 */
export class FuzzySuggestModal<T> extends Modal {
  placeholder = "";
  instructions: StubInstruction[] = [];
  emptyStateText = "";

  setPlaceholder(placeholder: string): void {
    this.placeholder = placeholder;
  }

  setInstructions(instructions: StubInstruction[]): void {
    this.instructions = instructions;
  }

  getItems(): T[] {
    return [];
  }

  getItemText(_item: T): string {
    return "";
  }

  onChooseItem(_item: T, _evt: MouseEvent | KeyboardEvent): void {}

  /**
   * Added wave 5 review: mirrors Obsidian's real `FuzzySuggestModal`, which
   * unwraps the `FuzzyMatch` and hands its item to `onChooseItem`.
   */
  onChooseSuggestion(match: StubFuzzyMatch<T>, evt: MouseEvent | KeyboardEvent): void {
    this.onChooseItem(match.item, evt);
  }

  /**
   * Added wave 5 review: mirrors the ORDER of Obsidian's real
   * `SuggestModal.selectSuggestion` -- it closes the modal FIRST (so
   * `onClose` runs) and only then calls `onChooseSuggestion`. A subclass
   * that settles "no choice" in `onClose` would discard every pick; this
   * ordering is what lets a test catch that.
   */
  selectSuggestion(match: StubFuzzyMatch<T>, evt: MouseEvent | KeyboardEvent): void {
    this.close();
    this.onChooseSuggestion(match, evt);
  }
}

/** Mirrors obsidian's `FuzzyMatch<T>` (`{ item, match }`) closely enough for a choose-order test. */
export interface StubFuzzyMatch<T> {
  item: T;
  match: { score: number; matches: [number, number][] };
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
