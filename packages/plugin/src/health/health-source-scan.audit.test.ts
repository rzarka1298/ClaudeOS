import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Source scan for the Diagnostics files (plan 08-13; DIAG-02; threats T-08-33 and T-08-34, the
 * prohibitions on a health fetch by timer and on any network call from the plugin): the health
 * module and the Diagnostics section name no network primitive and no client package, start no
 * timer, read no connection reason text, use no native disabled attribute, and send the `gesture`
 * trigger only from the two owner actions in the section. The scan reads comments too, so a
 * prohibition is described without using the words it prohibits.
 *
 * It lists the files by name. A new Diagnostics file must be added here, so the scan cannot
 * silently stop covering one.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEW_DIR = join(HERE, "..", "view");

const HEALTH_FILES = [
  "api.ts",
  "state.ts",
  "wiring.ts",
  // Plan 08-16: the bundle's input assembly, its export seam and the one file that writes.
  "bundle-input.ts",
  "export-port.ts",
  "export.ts",
] as const;
const VIEW_FILES = [
  "diagnostics-section.tsx",
  "diagnostics-row.tsx",
  "diagnostics-copy.ts",
  // Plan 08-15: the Security section reads the same health answer and fetches it once on open.
  "settings-security.tsx",
  // Plan 08-18: the Paths section reads the same health answer and fetches it once on open.
  "settings-paths.tsx",
  // Plan 08-16: the bundle block; its `Run checks again` is the third owner action.
  "diagnostics-bundle.tsx",
] as const;

/**
 * The only file that may touch Electron or the file system (plan 08-16): it is the export seam's
 * implementation. Everything else, the views above all, reaches it through `export-port.ts`.
 */
const EXPORT_FILE = "health/export.ts";
const FILE_SYSTEM_IMPORT = /^(electron|node:fs|node:fs\/promises|node:path)$/;

/** The component files (the a11y floor below applies to every one of them). */
const COMPONENT_FILES = VIEW_FILES.filter((file) => file.endsWith(".tsx"));

const SOURCES: readonly (readonly [string, string])[] = [
  ...HEALTH_FILES.map(
    (file) => [`health/${file}`, readFileSync(join(HERE, file), "utf8")] as const,
  ),
  ...VIEW_FILES.map(
    (file) => [`view/${file}`, readFileSync(join(VIEW_DIR, file), "utf8")] as const,
  ),
];

function sourceOf(name: string): string {
  const found = SOURCES.find(([file]) => file === name);
  if (found === undefined) throw new Error(`not scanned: ${name}`);
  return found[1];
}

/** The network primitives, assembled so this file names none of them outside these strings. */
const NETWORK = new RegExp(
  [
    "fetch\\(",
    "XMLHttpRe" + "quest",
    "Web" + "Socket",
    "request" + "Url",
    "node:" + "http",
    "node:" + "https",
    "node:" + "net",
    "Event" + "Source",
  ].join("|"),
);

const ALLOWED_IMPORT =
  /^(@ccc\/domain\/(diagnostics|diagnostic-bundle|display-path|auth)\.js|@ccc\/domain|preact|preact\/hooks|@preact\/signals|\.\/[\w-]+\.js|\.\.\/connection-state\.js|\.\.\/diagnostics\.js|\.\.\/motion\.js|\.\.\/host-registry\.js|\.\.\/health\/(api|state|bundle-input|export-port)\.js|\.\.\/projects\/projects-state\.js|\.\.\/widgets\/(footer|relative-time|session-signals)\.js)$/;

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gms)].map(
    (match) => match[1] as string,
  );
}

describe("the Diagnostics files make no network call and import no client (DIAG-02)", () => {
  it("covers a non-empty closed set of files", () => {
    expect(SOURCES).toHaveLength(HEALTH_FILES.length + VIEW_FILES.length);
    expect(SOURCES.every(([, source]) => source.length > 200)).toBe(true);
  });

  it.each(SOURCES)("%s names no network primitive", (_name, source) => {
    expect(source).not.toMatch(NETWORK);
  });

  it.each(SOURCES)(
    "%s imports only the domain, preact, signals and its siblings",
    (name, source) => {
      for (const specifier of importSpecifiers(source)) {
        // The export seam's implementation alone may also name Electron and the file system.
        const allowed =
          name === EXPORT_FILE ? [ALLOWED_IMPORT, FILE_SYSTEM_IMPORT] : [ALLOWED_IMPORT];
        expect(
          allowed.some((pattern) => pattern.test(specifier)),
          `unexpected import ${specifier} in ${name}`,
        ).toBe(true);
      }
      expect(source).not.toContain("service-api-client");
      expect(source).not.toMatch(/from ["']obsidian["']/);
    },
  );

  it("only export.ts imports node:fs/promises, node:fs, node:path or electron (plan 08-16, T-08-41, T-08-43)", () => {
    const importers = SOURCES.filter(([, source]) =>
      importSpecifiers(source).some((specifier) => FILE_SYSTEM_IMPORT.test(specifier)),
    ).map(([name]) => name);
    expect(importers).toEqual([EXPORT_FILE]);
    expect(importSpecifiers(sourceOf(EXPORT_FILE))).toContain("node:fs/promises");
  });

  it("no view reaches the export implementation: only wiring.ts imports export.js, so the harness bundle never sees Electron or the file system", () => {
    const importers = SOURCES.filter(([, source]) =>
      importSpecifiers(source).some((specifier) => /(^|\/)export\.js$/.test(specifier)),
    ).map(([name]) => name);
    expect(importers).toEqual(["health/wiring.ts"]);
  });

  it("export.ts is the only scanned file that writes: no other file names a write call", () => {
    const WRITE =
      /\b(writeFile|appendFile|createWriteStream|rename|link|symlink|unlink|mkdir|rm|copyFile)\s*\(/;
    for (const [name, source] of SOURCES) {
      if (name === EXPORT_FILE) continue;
      expect(source, `${name} writes a file`).not.toMatch(WRITE);
    }
    // It lands the file with `link`, which cannot replace anything, and never with `rename`,
    // which would (FIX4B m9, D-12a).
    expect(sourceOf(EXPORT_FILE)).toMatch(/\blink\s*\(/);
    expect(sourceOf(EXPORT_FILE)).not.toMatch(/\brename\s*\(/);
    expect(sourceOf(EXPORT_FILE)).not.toMatch(
      /\b(writeFile|createWriteStream)\s*\([^)]*\b(landing|target)\b/,
    );
  });

  it("the client function is injected: wiring.ts takes it as a dependency and imports nothing of it", () => {
    const wiring = sourceOf("health/wiring.ts");
    expect(wiring).toContain("readonly getHealth");
    expect(wiring).not.toContain("getDiagnosticsHealth");
  });
});

describe("the bundle is serialised in one place only (plan 08-16, D-12; FIX4B)", () => {
  it.each(["health/bundle-input.ts", "view/diagnostics-bundle.tsx"])(
    "%s neither stringifies nor serialises the bundle itself: the verifier's string is the only one",
    (name) => {
      const source = sourceOf(name);
      expect(source).not.toMatch(/JSON\.stringify/);
      expect(source).not.toMatch(/\bserialiseBundle\b/);
      // The one door is the domain's verifier.
      if (name === "health/bundle-input.ts") expect(source).toMatch(/\bverifyAndSerialise\b/);
    },
  );
});

describe("no health fetch runs on a timer (D-05)", () => {
  it.each(SOURCES)("%s starts no timer, interval or clock read", (_name, source) => {
    expect(source).not.toMatch(/\bset(?:Interval|Timeout)\s*\(/);
    expect(source).not.toMatch(/\bregistry\.(?:interval|timer)\b/);
    expect(source).not.toMatch(/\bDate\.now\s*\(/);
    expect(source).not.toMatch(/\bnowTick\b/);
  });

  it("refreshHealth has exactly the callers the plan names: the section's two owner actions and the reconnect hook", () => {
    const callers = SOURCES.flatMap(([name, source]) =>
      [...source.matchAll(/\brefreshHealth\(\s*"(\w+)"/g)].map((match) => `${name}:${match[1]}`),
    );
    expect(callers.sort()).toEqual([
      "health/state.ts:reconnect",
      // The bundle block's `Run checks again` (stale line and refusal panel): a press, one call site.
      "view/diagnostics-bundle.tsx:gesture",
      "view/diagnostics-section.tsx:gesture",
      "view/diagnostics-section.tsx:gesture",
      // Opening Paths is an owner action: the one fetch, from its mount effect (plan 08-18).
      "view/settings-paths.tsx:gesture",
      // Opening Security is an owner action: the one fetch, from its mount effect.
      "view/settings-security.tsx:gesture",
    ]);
  });

  it("the gesture trigger is never named outside the section and the API normaliser (Amendment A1)", () => {
    for (const [name, source] of SOURCES) {
      const count = (source.match(/["']gesture["']/g) ?? []).length;
      if (name === "view/diagnostics-section.tsx") expect(count).toBe(2);
      else if (name === "view/settings-security.tsx") expect(count).toBe(1);
      else if (name === "view/settings-paths.tsx") expect(count).toBe(1);
      else if (name === "view/diagnostics-bundle.tsx") expect(count).toBe(1);
      else if (name === "health/api.ts") expect(count).toBe(2);
      else expect(count, `${name} names the gesture trigger`).toBe(0);
    }
  });

  it("the two gesture fetches are the section opening and the Run checks again press", () => {
    const section = sourceOf("view/diagnostics-section.tsx");
    const opening = section.indexOf('refreshHealth("gesture"');
    const press = section.indexOf('refreshHealth("gesture"', opening + 1);
    expect(opening).toBeGreaterThan(-1);
    expect(press).toBeGreaterThan(opening);
    // The first sits in the mount effect, the second in the press handler.
    expect(section.slice(Math.max(0, opening - 400), opening)).toContain("useEffect");
    expect(section.slice(Math.max(0, press - 400), press)).toContain("runChecks");
  });
});

describe("no connection reason text and no raw error reaches a row (D-43, T-08-33)", () => {
  it.each(SOURCES)(
    "%s reads no connection reason and renders no error message",
    (_name, source) => {
      expect(source).not.toMatch(/\bconnection\.reason\b|\bstate\.reason\b|\.value\.reason\b/);
      expect(source).not.toMatch(/\berror\.message\b|\be\.message\b|\bString\(error\)/);
    },
  );
});

describe("controls are keyboard operable and honest about being unavailable (a11y floor 6)", () => {
  it.each(COMPONENT_FILES)("%s uses no native disabled attribute and no smooth scroll", (_name) => {
    const source = sourceOf(`view/${_name}`);
    expect(source).not.toMatch(/(?<![-\w])disabled\s*[=:]/);
    expect(source).not.toMatch(/behavior\s*:\s*["']smooth["']/);
  });

  it.each(COMPONENT_FILES)("%s renders no link, image, frame or style attribute", (_name) => {
    const source = sourceOf(`view/${_name}`);
    expect(source).not.toMatch(/<a\s|href=|<img|<iframe|<script|style=\{/);
  });
});
