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
 * Fidelity note, stated plainly because the byte-parity test leans on it:
 * Obsidian's `parseYaml`/`stringifyYaml` are documented as its bundled
 * js-yaml surface, and this stub calls js-yaml directly with the same
 * `safeLoad`/`safeDump` entry points gray-matter uses service-side. What
 * that proves in-repo is that this module's key-ordering logic reproduces
 * the service's bytes through one shared engine. What it cannot prove is
 * that Obsidian's own build passes identical dump options -- that residual
 * is exactly what the live-Obsidian UAT in this phase's verification
 * covers, and it is the reason the parity claim is asserted here rather
 * than assumed anywhere.
 */

/** Mirrors obsidian's `parseYaml(yaml: string): any`. */
export function parseYaml(input: string): unknown {
  return yaml.safeLoad(input);
}

/** Mirrors obsidian's `stringifyYaml(obj: any): string`. */
export function stringifyYaml(obj: unknown): string {
  return yaml.safeDump(obj);
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
