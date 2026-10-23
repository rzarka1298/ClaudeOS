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

const HEALTH_FILES = ["api.ts", "state.ts", "wiring.ts"] as const;
const VIEW_FILES = [
  "diagnostics-section.tsx",
  "diagnostics-row.tsx",
  "diagnostics-copy.ts",
  // Plan 08-15: the Security section reads the same health answer and fetches it once on open.
  "settings-security.tsx",
] as const;

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
  /^(@ccc\/domain\/(diagnostics|auth)\.js|@ccc\/domain|preact|preact\/hooks|@preact\/signals|\.\/[\w-]+\.js|\.\.\/connection-state\.js|\.\.\/host-registry\.js|\.\.\/health\/(api|state)\.js|\.\.\/widgets\/(footer|relative-time|session-signals)\.js)$/;

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
    (_name, source) => {
      for (const specifier of importSpecifiers(source)) {
        expect(specifier, `unexpected import ${specifier}`).toMatch(ALLOWED_IMPORT);
      }
      expect(source).not.toContain("service-api-client");
      expect(source).not.toMatch(/from ["']obsidian["']/);
    },
  );

  it("the client function is injected: wiring.ts takes it as a dependency and imports nothing of it", () => {
    const wiring = sourceOf("health/wiring.ts");
    expect(wiring).toContain("readonly getHealth");
    expect(wiring).not.toContain("getDiagnosticsHealth");
  });
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
      "view/diagnostics-section.tsx:gesture",
      "view/diagnostics-section.tsx:gesture",
      // Opening Security is an owner action: the one fetch, from its mount effect.
      "view/settings-security.tsx:gesture",
    ]);
  });

  it("the gesture trigger is never named outside the section and the API normaliser (Amendment A1)", () => {
    for (const [name, source] of SOURCES) {
      const count = (source.match(/["']gesture["']/g) ?? []).length;
      if (name === "view/diagnostics-section.tsx") expect(count).toBe(2);
      else if (name === "view/settings-security.tsx") expect(count).toBe(1);
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
