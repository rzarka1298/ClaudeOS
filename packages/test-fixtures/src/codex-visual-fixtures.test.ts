// The Codex visual matrix fixtures (plan 05.1-27; UI-SPEC "Visual regression").
//
// `codex-visual-fixtures.json` becomes pixels in committed screenshots, so it is
// a privacy surface exactly like `widget-fixtures.json` (PRIV-04, T-03-03,
// T-05.1-39). Three things are proven here without a browser:
//   1. every part of every case parses with the STRICT domain schemas the
//      service sends, so a fixture can never carry a field the product has no
//      home for (no path, no account, no prompt);
//   2. the file holds only invented names, no home path, no email, no host
//      name and no forbidden key, and every time derives from the frozen now;
//   3. the cases the UI-SPEC lists exist and hold the shape each one exists to
//      show.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexIntegrationStatusSchema } from "@ccc/domain/codex-integration.js";
import {
  CodexSessionsSnapshotSchema,
  CodexTokenSummarySchema,
} from "@ccc/domain/codex-sessions.js";
import { CodexUsageSnapshotSchema, HeadroomSignalSchema } from "@ccc/domain/codex-usage.js";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, "codex-visual-fixtures.json");
const WIDGET_FIXTURE_PATH = join(HERE, "widget-fixtures.json");

/** Exactly the two regexes `scripts/check-privacy.sh` enforces over tracked text. */
const HOME_PATH_RE = /\/Users\/[A-Za-z0-9._$<>-]+\/?/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
/** A host-name-looking value: dotted labels ending in a common top-level domain. */
const HOSTNAME_RE =
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|dev|app|local|lan|internal|invalid|test|example)\b/i;
/** Keys no fixture may carry: the strict schemas have no home for them either. */
const FORBIDDEN_KEYS = ["path", "cwd", "rollout", "account", "prompt", "email", "host"] as const;

/** The only project names a fixture may print. */
const INVENTED_WORDS = new Set([
  "Alpha",
  "Bravo",
  "Charlie",
  "Delta",
  "Echo",
  "Foxtrot",
  "Golf",
  "Hotel",
  "India",
  "Juliet",
]);

/** The cases the UI-SPEC "Visual regression" table lists, in order. Grown per task. */
const REQUIRED_CASES = ["ready-mixed"] as const;

interface Parts {
  readonly sessions: unknown;
  readonly usage: unknown;
  readonly headroom: unknown;
  readonly tokens: unknown;
  readonly integration: unknown;
}

interface Case {
  readonly parts: Parts;
  readonly connection?: string;
  readonly override?: string;
}

interface FixtureFile {
  readonly now: string;
  readonly cases: Readonly<Record<string, Case>>;
}

const text = readFileSync(FIXTURE_PATH, "utf8");
const fixtures = JSON.parse(text) as FixtureFile;
const NOW = Date.parse(fixtures.now);

function walk(value: unknown, visit: (key: string | null, value: unknown) => void): void {
  visit(null, value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      visit(key, child);
      walk(child, visit);
    }
  }
}

function nullable(parse: (value: unknown) => { success: boolean }, value: unknown): void {
  if (value === null) return;
  expect(parse(value).success).toBe(true);
}

describe("codex-visual-fixtures.json shape", () => {
  it("is frozen to the same now as the widget fixtures", () => {
    const widget = JSON.parse(readFileSync(WIDGET_FIXTURE_PATH, "utf8")) as { now: string };
    expect(fixtures.now).toBe(widget.now);
  });

  it("holds every case the UI-SPEC lists", () => {
    for (const id of REQUIRED_CASES) expect(Object.keys(fixtures.cases)).toContain(id);
  });

  it("parses every part of every case with the strict domain schemas", () => {
    for (const [id, fixture] of Object.entries(fixtures.cases)) {
      const { parts } = fixture;
      const label = `case ${id}`;
      expect(Object.keys(parts).sort(), label).toEqual(
        ["headroom", "integration", "sessions", "tokens", "usage"].sort(),
      );
      nullable((v) => CodexSessionsSnapshotSchema.safeParse(v), parts.sessions);
      nullable((v) => CodexUsageSnapshotSchema.safeParse(v), parts.usage);
      nullable((v) => HeadroomSignalSchema.safeParse(v), parts.headroom);
      nullable((v) => CodexTokenSummarySchema.safeParse(v), parts.tokens);
      nullable((v) => CodexIntegrationStatusSchema.safeParse(v), parts.integration);
    }
  });

  it("ready-mixed holds the mix the UI-SPEC describes, with sessions and token activity", () => {
    const mixed = fixtures.cases["ready-mixed"];
    expect(mixed).toBeDefined();
    if (mixed === undefined) return;
    const sessions = CodexSessionsSnapshotSchema.parse(mixed.parts.sessions);
    const usage = CodexUsageSnapshotSchema.parse(mixed.parts.usage);
    const headroom = HeadroomSignalSchema.parse(mixed.parts.headroom);
    const tokens = CodexTokenSummarySchema.parse(mixed.parts.tokens);

    expect(sessions.kind).toBe("available");
    if (sessions.kind !== "available") return;
    const states = sessions.sessions.map((session) => session.state);
    expect(states.filter((state) => state === "running").length).toBeGreaterThanOrEqual(1);
    for (const state of ["limit-paused", "stale", "failed", "completed"] as const) {
      expect(states, state).toContain(state);
    }
    const paused = sessions.sessions.find((session) => session.state === "limit-paused");
    expect(paused?.resumesAfter).not.toBeNull();
    expect(sessions.analysisOn).toBe(true);

    expect(usage.kind).toBe("available");
    if (usage.kind !== "available") return;
    expect(usage.windows).toHaveLength(1);
    expect(usage.windows[0]?.windowMinutes).toBe(10_080);
    expect(usage.windows[0]?.usedPercent).toBe(41);

    expect(headroom.claude.kind).toBe("available");
    if (headroom.claude.kind === "available") expect(headroom.claude.usedPercent).toBe(62);
    expect(headroom.codex.verdict).toBe("allow");
    expect(headroom.codex.worstWindow?.usedPercent).toBe(41);

    expect(tokens.ranges.today.kind).toBe("available");
    expect(tokens.firstScanPending).toBe(false);
  });
});

describe("codex-visual-fixtures.json privacy by construction (PRIV-04, T-05.1-39)", () => {
  it("contains no absolute home path, email address or host name", () => {
    expect(HOME_PATH_RE.test(text)).toBe(false);
    expect(EMAIL_RE.test(text)).toBe(false);
    expect(HOSTNAME_RE.test(text)).toBe(false);
  });

  it("carries no forbidden key at any depth", () => {
    const found: string[] = [];
    walk(fixtures, (key) => {
      if (key !== null && (FORBIDDEN_KEYS as readonly string[]).includes(key.toLowerCase())) {
        found.push(key);
      }
    });
    expect(found).toEqual([]);
  });

  it("names projects only from the invented list", () => {
    const names: string[] = [];
    walk(fixtures, (key, value) => {
      if ((key === "projectName" || key === "name") && typeof value === "string") {
        names.push(value);
      }
    });
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      for (const word of name.split(/[^A-Za-z0-9]+/).filter((part) => part.length > 0)) {
        expect(INVENTED_WORDS.has(word), `${name} -> ${word}`).toBe(true);
      }
    }
  });

  it("derives every time from the frozen now (within 45 days of it)", () => {
    const times: string[] = [];
    walk(fixtures, (_key, value) => {
      if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
        times.push(value);
      }
    });
    expect(times.length).toBeGreaterThan(0);
    for (const time of times) {
      const delta = Math.abs(Date.parse(time) - NOW);
      expect(Number.isNaN(delta), time).toBe(false);
      expect(delta, time).toBeLessThanOrEqual(45 * 86_400_000);
    }
  });
});
