import {
  COLLECTORS_PART_IDS,
  COLLECTORS_REASONS,
  HOOKS_REASONS,
  LAUNCHER_PART_IDS,
  LAUNCHERS_REASONS,
  SCHEDULER_PART_IDS,
  SCHEDULER_REASONS,
  SERVICE_REASONS,
  SETTINGS_SECTION_IDS,
  SETUP_COMMAND_IDS,
  type SetupAction,
  SUBSYSTEM_STATUS_DISPLAY,
  VAULT_REASONS,
} from "@ccc/domain/diagnostics.js";
import { describe, expect, it } from "vitest";
import {
  type AnyReason,
  chipFor,
  displayedAction,
  HIDE_DETAILS_LABEL,
  PART_NAMES,
  REASON_COPY,
  reasonText,
  SETUP_ACTION_COPY,
  SETUP_COMMANDS,
  setupActionLabel,
  showDetailsLabel,
  showDetailsName,
  summaryFor,
} from "./diagnostics-copy.js";
import { CLAUDE_INSTALL_COMMAND } from "./settings-model.js";

/**
 * Plan 08-13 Task 2, Test 1 (and the copy half of Tests 3 and 4): every reason code of every
 * subsystem has a fixed sentence, no sentence carries a path, a name or an error message, and the
 * setup-action text is plugin-owned.
 */

const NOW = Date.parse("2026-10-22T09:30:00.000Z");

/** Every reason the section can be asked to explain, from the domain's own lists. */
const ALL_REASONS: readonly AnyReason[] = [
  ...new Set([
    ...VAULT_REASONS,
    ...HOOKS_REASONS,
    ...COLLECTORS_REASONS,
    ...SCHEDULER_REASONS,
    ...LAUNCHERS_REASONS,
    ...SERVICE_REASONS,
  ]),
];

const FULL_FACTS = {
  claudeVersion: "2.0.1",
  minimumVersion: "2.1.0",
  dropCount: 3,
  lastDropAt: "2026-10-22T09:00:00.000Z",
  silenceThresholdMs: 600_000,
  sourceCount: 5,
  lastSuccessAt: "2026-10-22T08:00:00.000Z",
  lastFailureAt: "2026-10-22T07:00:00.000Z",
} as const;

describe("REASON_COPY (Test 1: exhaustive)", () => {
  it("has an entry for every reason code of every subsystem", () => {
    expect(ALL_REASONS.length).toBeGreaterThan(70);
    const missing = ALL_REASONS.filter((code) => REASON_COPY[code] === undefined);
    expect(missing).toEqual([]);
  });

  it("has no entry for a code the domain does not know", () => {
    const known = new Set<string>(ALL_REASONS);
    expect(Object.keys(REASON_COPY).filter((code) => !known.has(code))).toEqual([]);
  });

  it.each(ALL_REASONS)(
    "%s: a sentence that ends with a period and holds no path, name or placeholder",
    (code) => {
      for (const facts of [undefined, FULL_FACTS]) {
        const { reason, nextStep } = reasonText(code, { facts, now: NOW });
        for (const sentence of [reason, ...(nextStep === null ? [] : [nextStep])]) {
          expect(sentence.length).toBeGreaterThan(0);
          expect(sentence.endsWith(".")).toBe(true);
          expect(sentence).not.toMatch(/[/@~\\]/);
          expect(sentence).not.toMatch(/[{}]|undefined|NaN|null/);
        }
      }
    },
  );

  it("uses the lowercase section references and Run checks again (R-F1, R-F2)", () => {
    const every = ALL_REASONS.flatMap((code) => {
      const text = reasonText(code, { facts: FULL_FACTS, now: NOW });
      return [text.reason, text.nextStep ?? ""];
    }).join("\n");
    expect(every).not.toMatch(/Check again/);
    expect(every).not.toMatch(/Go to Launchers|Go to Security|Go to Integrations/);
    expect(reasonText("probe-timeout", { facts: undefined, now: NOW }).nextStep).toBe(
      "Press Run checks again.",
    );
    expect(reasonText("bundle-not-found", { facts: undefined, now: NOW }).nextStep).toBe(
      "Choose it again in the launchers section.",
    );
  });
});

describe("reason sentences interpolate typed values only", () => {
  const sentence = (code: AnyReason, facts?: typeof FULL_FACTS | Record<string, unknown>) =>
    reasonText(code, { facts, now: NOW }).reason;

  it("names the silence threshold as a duration", () => {
    expect(sentence("events-silent", { silenceThresholdMs: 600_000 })).toBe(
      "No hook event for more than 10 minutes. That is normal when no session is running.",
    );
    expect(sentence("events-silent")).toBe(
      "No hook event for more than 10 minutes. That is normal when no session is running.",
    );
  });

  it("names the versions when both are known, and nothing invented when they are not", () => {
    expect(sentence("telemetry-unsupported-version", FULL_FACTS)).toBe(
      "Claude Code 2.0.1 is older than the minimum supported 2.1.0.",
    );
    expect(sentence("telemetry-unsupported-version")).toBe(
      "Claude Code is older than the minimum supported version.",
    );
  });

  it("reads the dropped-records fact as a count and a local time (FIX2A)", () => {
    const text = sentence("spool-dropped-records", FULL_FACTS);
    expect(text.startsWith("Hook records were dropped: 3, the latest at ")).toBe(true);
    expect(text.endsWith(" Some sessions may be missing events.")).toBe(true);
    expect(sentence("spool-dropped-records")).toBe(
      "Hook records were dropped. Some sessions may be missing events.",
    );
    expect(sentence("spool-clean")).toBe("No hook records have been dropped.");
    // spool-clean may carry an older drop as a fact: the count is never shown as a status.
    expect(sentence("spool-clean", { dropCount: 2, lastDropAt: "2026-10-01T09:00:00.000Z" })).toBe(
      "No hook records were dropped in the last 24 hours.",
    );
  });

  it("reads the last research run relative to now, and the source count with a plural", () => {
    expect(sentence("last-run-succeeded", FULL_FACTS)).toBe(
      "The last research run finished 1 hour ago.",
    );
    expect(sentence("last-run-succeeded")).toBe("The last research run finished.");
    expect(sentence("sources-configured", { sourceCount: 5 })).toBe(
      "5 research sources are configured.",
    );
    expect(sentence("sources-configured", { sourceCount: 1 })).toBe(
      "1 research source is configured.",
    );
    expect(sentence("sources-configured")).toBe("Research sources are configured.");
  });

  it("gives each failed run the Phase 7 reason text mid-sentence and its Phase 7 next step", () => {
    expect(sentence("run-all-sources-failed")).toBe(
      "The last run failed: no source could be fetched.",
    );
    expect(reasonText("run-all-sources-failed", { facts: undefined, now: NOW }).nextStep).toBe(
      "Check your network connection, then press Run now.",
    );
    expect(sentence("run-summariser-unconfigured")).toBe("The summariser isn't set up.");
    expect(sentence("run-interrupted")).toBe(
      "The last run ended without reporting, so its result is unknown.",
    );
  });
});

describe("status chips (D-06, UI-SPEC R-note)", () => {
  it("reads glyph and word from the shared display map", () => {
    for (const status of ["setup-needed", "degraded", "failing", "unknown"] as const) {
      expect(chipFor(status, "vault")).toEqual({
        glyph: SUBSYSTEM_STATUS_DISPLAY[status].glyph,
        word: SUBSYSTEM_STATUS_DISPLAY[status].word,
      });
    }
    expect(chipFor("ok", "vault")).toEqual({ glyph: "✓", word: "Working" });
  });

  it("reads Running, not Working, for the reachable service", () => {
    expect(chipFor("ok", "service")).toEqual({ glyph: "✓", word: "Running" });
    expect(chipFor("failing", "service").word).toBe("Failing");
  });
});

describe("setup actions are three closed kinds (D-08, D-39, T-08-35)", () => {
  it("maps each command id to the existing repository-relative constant", () => {
    expect(Object.keys(SETUP_COMMANDS).sort()).toEqual([...SETUP_COMMAND_IDS].sort());
    expect(SETUP_COMMANDS["claude-hooks-install"]).toBe(CLAUDE_INSTALL_COMMAND);
    expect(SETUP_COMMANDS["claude-hooks-install"]).toBe("./scripts/claude-hooks/install.sh");
    expect(SETUP_COMMANDS["codex-hooks-install"]).toBe("./scripts/codex-hooks/install.sh");
    expect(SETUP_COMMANDS["codex-bridge-install"]).toBe("node scripts/codex/install-user-kit.mjs");
    expect(SETUP_COMMANDS["research-key-setup"]).toBe("node scripts/research-key-setup.mjs");
    for (const command of Object.values(SETUP_COMMANDS)) {
      // Repository-relative, never absolute, never a home path.
      expect(command).not.toMatch(/(^|\s)\/|~|\$HOME/);
    }
  });

  it("labels every action with a verb and a noun, and every section with a lowercase reference", () => {
    const labels = new Set<string>();
    for (const command of SETUP_COMMAND_IDS) {
      labels.add(setupActionLabel({ kind: "copy-command", command }));
    }
    expect([...labels].sort()).toEqual(["Copy install command", "Copy key setup command"]);
    expect(setupActionLabel({ kind: "run-plugin-command", command: "vault-setup" })).toBe(
      "Set up vault",
    );
    const expected: Record<string, string> = {
      projects: "Go to the projects section",
      launchers: "Go to the launchers section",
      integrations: "Go to the integrations section",
      "approvals-tasks": "Go to the approvals and tasks section",
      paths: "Go to the paths section",
      visual: "Go to the visual section",
      security: "Go to the security section",
      schedules: "Go to the schedules section",
      diagnostics: "Go to diagnostics",
      research: "Open the research view",
    };
    for (const section of [...SETTINGS_SECTION_IDS, "research"] as const) {
      expect(setupActionLabel({ kind: "go-to-section", section })).toBe(expected[section]);
    }
  });

  it("has copied and failure notices for each command and none of them holds a path", () => {
    for (const command of SETUP_COMMAND_IDS) {
      const action: SetupAction = { kind: "copy-command", command };
      const copy = SETUP_ACTION_COPY.copied(action);
      expect(copy).toMatch(/copied\. Run it in Terminal\.$/);
    }
    expect(SETUP_ACTION_COPY.copyFailed).not.toMatch(/[/@~]/);
  });
});

describe("summaryFor (Test 4)", () => {
  const row = (status: "ok" | "setup-needed" | "degraded" | "failing" | "unknown") => ({ status });

  it("reads the fresh install: Nothing is failing, one working, five need setup", () => {
    const summary = summaryFor([
      row("ok"),
      row("setup-needed"),
      row("setup-needed"),
      row("setup-needed"),
      row("setup-needed"),
      row("setup-needed"),
    ]);
    expect(summary.lead).toBe("Nothing is failing.");
    expect(summary.chips.map((chip) => chip.text)).toEqual(["1 working", "5 need setup"]);
    expect(summary.chips.map((chip) => chip.status)).toEqual(["ok", "setup-needed"]);
  });

  it("reads attention when anything fails or degrades, singular and plural", () => {
    expect(
      summaryFor([row("ok"), row("failing"), row("degraded"), row("ok"), row("ok"), row("ok")])
        .lead,
    ).toBe("2 subsystems need attention.");
    expect(
      summaryFor([row("ok"), row("failing"), row("ok"), row("ok"), row("ok"), row("ok")]).lead,
    ).toBe("1 subsystem needs attention.");
  });

  it("reads unknown ones when nothing fails", () => {
    expect(
      summaryFor([row("ok"), row("unknown"), row("ok"), row("ok"), row("ok"), row("ok")]).lead,
    ).toBe("Nothing is failing. 1 couldn't be checked.");
    expect(
      summaryFor([row("ok"), row("unknown"), row("unknown"), row("ok"), row("ok"), row("ok")]).lead,
    ).toBe("Nothing is failing. 2 couldn't be checked.");
  });

  it("reads all six working, and hides every zero chip; chips run failing, degraded, unknown, setup, working", () => {
    const allOk = summaryFor(Array.from({ length: 6 }, () => row("ok")));
    expect(allOk.lead).toBe("All six subsystems are working.");
    expect(allOk.chips.map((chip) => chip.text)).toEqual(["6 working"]);

    const mixed = summaryFor([
      row("ok"),
      row("failing"),
      row("degraded"),
      row("unknown"),
      row("setup-needed"),
      row("setup-needed"),
    ]);
    expect(mixed.chips.map((chip) => `${chip.glyph} ${chip.text}`)).toEqual([
      "✕ 1 failing",
      "▽ 1 degraded",
      "? 1 unknown",
      "✓ 1 working",
      "⊕ 2 need setup",
    ]);
    expect(
      summaryFor([
        row("ok"),
        row("ok"),
        row("ok"),
        row("ok"),
        row("ok"),
        row("setup-needed"),
      ]).chips.map((chip) => chip.text),
    ).toEqual(["5 working", "1 needs setup"]);
  });
});

describe("the parts disclosure text (Test 2)", () => {
  it("pluralises the count with Intl.PluralRules", () => {
    expect(showDetailsLabel(8)).toBe("Show details (8)");
    expect(showDetailsName("Usage collectors", 8)).toBe(
      "Show details for Usage collectors: 8 parts",
    );
    expect(showDetailsName("App launchers", 1)).toBe("Show details for App launchers: 1 part");
    expect(HIDE_DETAILS_LABEL).toBe("Hide details");
  });

  it("names every part the service can send", () => {
    for (const id of [...COLLECTORS_PART_IDS, ...SCHEDULER_PART_IDS, ...LAUNCHER_PART_IDS]) {
      expect(PART_NAMES[id]).toBeTruthy();
    }
    expect(PART_NAMES["claude-code"]).toBe("Claude Code");
    expect(PART_NAMES.codex).toBe("Codex");
  });
});

describe("sentence case (R-F1)", () => {
  /** Product names, button names and the one quoted UI string the copy may capitalise mid-sentence. */
  const ALLOWED = new Set([
    "Claude",
    "Code",
    "Codex",
    "Obsidian",
    "Terminal",
    "Finder",
    "Antigravity",
    "Anthropic",
    "Mac",
    "API",
    "Run",
    "Check",
    "Settings",
    "Diagnostics",
  ]);

  function capitalisedMidSentence(text: string): string[] {
    const withoutQuoted = text.replace(/"[^"]*"/g, "");
    const found: string[] = [];
    for (const sentence of withoutQuoted.split(/(?<=[.!?])\s+/)) {
      const words = sentence.split(/\s+/).slice(1);
      for (const word of words) {
        const bare = word.replace(/^[("']+|[.,;:!?)'"]+$/g, "").replace(/'s$/, "");
        if (/^[A-Z]/.test(bare) && !ALLOWED.has(bare)) found.push(bare);
      }
    }
    return found;
  }

  it("capitalises no running-copy word outside the product names", () => {
    const offenders: string[] = [];
    for (const code of ALL_REASONS) {
      const { reason, nextStep } = reasonText(code, { facts: FULL_FACTS, now: NOW });
      for (const sentence of [reason, nextStep ?? ""]) {
        const words = capitalisedMidSentence(sentence);
        // A formatted date or time carries its own capitals (month name, AM); it is a typed value.
        const real = words.filter((word) => !/^(?:Oct|AM|PM)$/.test(word));
        if (real.length > 0) offenders.push(`${code}: ${real.join(", ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("writes every section label in lower case after the verb", () => {
    for (const section of SETTINGS_SECTION_IDS) {
      const label = setupActionLabel({ kind: "go-to-section", section });
      expect(capitalisedMidSentence(label)).toEqual([]);
    }
  });
});

describe("displayedAction (FIX3A MINOR-7: the service sends the launchers section, the plugin shows it as sent)", () => {
  const INTEGRATIONS: SetupAction = { kind: "go-to-section", section: "integrations" };
  const LAUNCHERS: SetupAction = { kind: "go-to-section", section: "launchers" };

  it("no longer redirects: the Codex doctor reasons keep exactly the action the service sent", () => {
    for (const code of [
      "codex-doctor-not-run",
      "codex-doctor-warning",
      "codex-doctor-failed",
    ] as const) {
      expect(displayedAction(code, LAUNCHERS)).toBe(LAUNCHERS);
      expect(displayedAction(code, INTEGRATIONS)).toBe(INTEGRATIONS);
    }
  });

  it("leaves every other action exactly as the service sent it", () => {
    expect(displayedAction("codex-hooks-not-installed", INTEGRATIONS)).toBe(INTEGRATIONS);
    const copy: SetupAction = { kind: "copy-command", command: "codex-bridge-install" };
    expect(displayedAction("codex-bridge-outdated", copy)).toBe(copy);
    expect(displayedAction("codex-doctor-ok", undefined)).toBeUndefined();
  });

  it("the label for the launchers section still names it", () => {
    expect(setupActionLabel(LAUNCHERS)).toBe("Go to the launchers section");
  });
});
