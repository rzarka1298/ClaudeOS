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
import {
  CODEX_USAGE_STALE_MAX_AGE_MS,
  CodexUsageSnapshotSchema,
  HeadroomSignalSchema,
} from "@ccc/domain/codex-usage.js";
import { LAUNCH_ERROR_KINDS } from "@ccc/domain/launch.js";
import { ProjectIdSchema } from "@ccc/domain/projects.js";
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
const REQUIRED_CASES = [
  "ready-mixed",
  "ready-over-reserve",
  "ready-fallback-source",
  "ready-analysis-off",
  "ready-partial-sessions",
  "ready-partial-tokens",
  "usage-unavailable",
  "usage-outdated",
  "empty",
  "loading",
  "stale",
  "error",
  "disconnected",
  "setup-not-installed",
  "unavailable-format-changed",
  "long-text",
] as const;

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

interface PairLine {
  readonly kind: string;
  readonly error?: string;
}

interface LaunchFixture {
  readonly terminalLabel: string;
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  readonly pairProjectId: string;
  readonly pairs: Readonly<Record<string, { readonly claude: PairLine; readonly codex: PairLine }>>;
}

interface FixtureFile {
  readonly now: string;
  readonly cases: Readonly<Record<string, Case>>;
  readonly launch: LaunchFixture;
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

/** One case's parts, parsed with the strict schemas (the shape tests below read typed values). */
function parsed(id: string) {
  const fixture = fixtures.cases[id];
  expect(fixture, `case ${id}`).toBeDefined();
  const parts = (fixture as Case).parts;
  return {
    fixture: fixture as Case,
    sessions: parts.sessions === null ? null : CodexSessionsSnapshotSchema.parse(parts.sessions),
    usage: parts.usage === null ? null : CodexUsageSnapshotSchema.parse(parts.usage),
    headroom: parts.headroom === null ? null : HeadroomSignalSchema.parse(parts.headroom),
    tokens: parts.tokens === null ? null : CodexTokenSummarySchema.parse(parts.tokens),
    integration:
      parts.integration === null ? null : CodexIntegrationStatusSchema.parse(parts.integration),
  };
}

function sessionStates(id: string): string[] {
  const { sessions } = parsed(id);
  return sessions?.kind === "available" ? sessions.sessions.map((session) => session.state) : [];
}

describe("every case holds the shape the UI-SPEC row says it exists to show", () => {
  it("ready-over-reserve: a window at 83 percent, refusal by the reserve line, two paused runs", () => {
    const { usage, headroom } = parsed("ready-over-reserve");
    expect(usage?.kind === "available" && usage.windows[0]?.usedPercent).toBe(83);
    expect(headroom?.codex.verdict).toBe("refuse");
    expect(headroom?.codex.reason).toBe("reserve-line");
    expect(headroom?.codex.pausedRuns.count).toBe(2);
    expect(sessionStates("ready-over-reserve").filter((s) => s === "limit-paused")).toHaveLength(2);
  });

  it("ready-fallback-source: the usage came from the rollout fallback and headroom refuses with no live read", () => {
    const { usage, headroom } = parsed("ready-fallback-source");
    expect(usage?.kind === "available" && usage.source).toBe("rollout-fallback");
    expect(headroom?.codex.reason).toBe("no-live-read");
  });

  it("ready-analysis-off: no titles, analysis off, token activity unavailable for analysis-off", () => {
    const { sessions, tokens } = parsed("ready-analysis-off");
    expect(sessions?.kind === "available" && sessions.analysisOn).toBe(false);
    expect(
      sessions?.kind === "available" && sessions.sessions.every((row) => row.title === null),
    ).toBe(true);
    for (const range of Object.values(tokens?.ranges ?? {})) {
      expect(range.kind === "unavailable" && range.reason).toBe("analysis-off");
    }
  });

  it("ready-partial-sessions: sessions unavailable for a changed format with a dotted version, usage and tokens available", () => {
    const { sessions, usage, tokens } = parsed("ready-partial-sessions");
    expect(sessions?.kind === "unavailable" && sessions.reason).toBe("format-changed");
    expect(sessions?.kind === "unavailable" && sessions.version).toMatch(/^\d+(?:\.\d+)+$/);
    expect(usage?.kind).toBe("available");
    expect(tokens?.ranges.today.kind).toBe("available");
  });

  it("ready-partial-tokens: at least one range is partial with a retention horizon", () => {
    const { tokens } = parsed("ready-partial-tokens");
    const partial = Object.values(tokens?.ranges ?? {}).filter(
      (range) => range.kind === "available" && range.partiality.partial,
    );
    expect(partial.length).toBeGreaterThanOrEqual(1);
    expect(
      partial.some((range) => range.kind === "available" && range.coverage.horizonDate !== null),
    ).toBe(true);
  });

  it("usage-unavailable: an unavailable variant with a reason and no numeric member", () => {
    const { usage, headroom, fixture } = parsed("usage-unavailable");
    expect(usage?.kind).toBe("unavailable");
    const numbers: number[] = [];
    walk(fixture.parts.usage, (_key, value) => {
      if (typeof value === "number") numbers.push(value);
    });
    expect(numbers).toEqual([]);
    expect(headroom?.codex.reason).toBe("usage-unavailable");
    expect(headroom?.codex.worstWindow).toBeNull();
  });

  it("usage-outdated: a window whose reset precedes the frozen now", () => {
    const { usage } = parsed("usage-outdated");
    expect(usage?.kind).toBe("available");
    if (usage?.kind !== "available") return;
    const reset = usage.windows[0]?.resetsAt;
    expect(reset).toBeTruthy();
    expect(Date.parse(reset ?? "")).toBeLessThan(NOW);
  });

  it("empty: everything null but the integration, with Codex installed", () => {
    const { fixture, integration } = parsed("empty");
    const { integration: _integration, ...rest } = fixture.parts;
    expect(Object.values(rest).every((part) => part === null)).toBe(true);
    expect(integration?.codex.installed).toBe(true);
  });

  it("loading and error carry the override and no data", () => {
    expect(fixtures.cases.loading?.override).toBe("loading");
    expect(fixtures.cases.error?.override).toBe("error");
    for (const id of ["loading", "error"]) {
      expect(Object.values((fixtures.cases[id] as Case).parts).every((part) => part === null)).toBe(
        true,
      );
    }
  });

  it("stale: every observation is older than the stale threshold", () => {
    const { sessions, usage, headroom, tokens } = parsed("stale");
    const observed = [
      sessions?.kind === "available" ? sessions.observedAt : null,
      usage?.observedAt ?? null,
      headroom?.generatedAt ?? null,
      tokens?.observedAt ?? null,
    ];
    for (const time of observed) {
      expect(time).not.toBeNull();
      expect(NOW - Date.parse(time ?? "")).toBeGreaterThan(CODEX_USAGE_STALE_MAX_AGE_MS);
    }
  });

  it("disconnected: the ready-mixed parts with a dropped connection", () => {
    expect(fixtures.cases.disconnected?.connection).toBe("disconnected");
    expect(fixtures.cases.disconnected?.parts).toEqual(fixtures.cases["ready-mixed"]?.parts);
  });

  it("setup-not-installed: Codex is not installed", () => {
    expect(parsed("setup-not-installed").integration?.codex.installed).toBe(false);
  });

  it("unavailable-format-changed: every data section is format-changed", () => {
    const { sessions, usage, tokens } = parsed("unavailable-format-changed");
    expect(sessions?.kind === "unavailable" && sessions.reason).toBe("format-changed");
    expect(usage?.kind === "unavailable" && usage.reason).toBe("shape-changed");
    for (const range of Object.values(tokens?.ranges ?? {})) {
      expect(range.kind === "unavailable" && range.reason).toBe("format-changed");
    }
  });

  it("long-text: a 90-character project name, a 60-character model, a 24-character effort and a 40-character limit label", () => {
    const { sessions, usage } = parsed("long-text");
    const rows = sessions?.kind === "available" ? sessions.sessions : [];
    expect(rows.some((row) => row.projectName?.length === 90)).toBe(true);
    expect(rows.some((row) => row.model?.length === 60)).toBe(true);
    expect(rows.some((row) => row.effort?.length === 24)).toBe(true);
    expect(
      usage?.kind === "available" && usage.windows.some((w) => w.limitLabel?.length === 40),
    ).toBe(true);
  });
});

/** The five pair-launch status cases of the UI-SPEC "Visual regression" table. */
const PAIR_CASES = ["opening", "success-error", "setup", "window-not-ready", "both-error"] as const;

describe("the launch block feeds the toolbar and pair-launch cells", () => {
  const { launch } = fixtures;

  it("shows the Antigravity terminal and two invented projects with real project ids", () => {
    expect(launch.terminalLabel).toBe("Antigravity");
    expect(launch.projects.map((project) => project.name)).toEqual(["Alpha", "Bravo"]);
    for (const project of launch.projects) {
      expect(ProjectIdSchema.safeParse(project.id).success, project.id).toBe(true);
    }
    expect(launch.projects.map((project) => project.id)).toContain(launch.pairProjectId);
  });

  it("holds exactly the five pair cases, each with a Claude line and a Codex line", () => {
    expect(Object.keys(launch.pairs)).toEqual([...PAIR_CASES]);
    for (const [id, pair] of Object.entries(launch.pairs)) {
      for (const line of [pair.claude, pair.codex]) {
        expect(["opening", "success", "error", "setup"], id).toContain(line.kind);
        if (line.kind === "error") {
          expect(LAUNCH_ERROR_KINDS as readonly string[], id).toContain(line.error);
        } else {
          expect(line.error, id).toBeUndefined();
        }
      }
      // Claude's missing launcher is an error, never a setup state (UI-SPEC S2).
      expect(pair.claude.kind, id).not.toBe("setup");
    }
  });

  it("encodes the locked per-case statuses", () => {
    const { pairs } = launch;
    expect(pairs.opening).toEqual({ claude: { kind: "opening" }, codex: { kind: "opening" } });
    expect(pairs["success-error"]?.claude.kind).toBe("success");
    expect(pairs["success-error"]?.codex).toEqual({ kind: "error", error: "bridge-outdated" });
    expect(pairs.setup?.codex.kind).toBe("setup");
    expect(pairs["window-not-ready"]?.claude.error).toBe("window-not-ready");
    expect(pairs["window-not-ready"]?.codex.error).toBe("window-not-ready");
    expect(pairs["both-error"]?.claude.error).toBe("bridge-not-installed");
    expect(pairs["both-error"]?.codex.error).toBe("bridge-not-installed");
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
