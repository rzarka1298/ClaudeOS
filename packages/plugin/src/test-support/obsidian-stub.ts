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

export class FileSystemAdapter {
  private readonly basePath: string;

  constructor(basePath = "") {
    this.basePath = basePath;
  }

  getBasePath(): string {
    return this.basePath;
  }
}
