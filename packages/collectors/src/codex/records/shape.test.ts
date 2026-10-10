import { describe, expect, it } from "vitest";
import {
  buildThreadsSelect,
  classifyThreadSource,
  evaluateRolloutCanary,
  evaluateStoreShape,
  NEVER_SELECT_THREAD_COLUMNS,
  OPTIONAL_THREAD_COLUMNS,
  PROMPT_DERIVED_THREAD_COLUMNS,
  REQUIRED_THREAD_COLUMNS,
} from "./shape.js";

/** The 42 column names of the current `threads` table (RESEARCH R3, reconciled in R-CODEX-ENV). */
const CURRENT_COLUMNS = [
  "id",
  "rollout_path",
  "created_at",
  "updated_at",
  "source",
  "model_provider",
  "cwd",
  "title",
  "sandbox_policy",
  "approval_mode",
  "tokens_used",
  "has_user_event",
  "archived",
  "archived_at",
  "git_sha",
  "git_branch",
  "git_origin_url",
  "cli_version",
  "first_user_message",
  "agent_nickname",
  "agent_role",
  "memory_mode",
  "model",
  "reasoning_effort",
  "agent_path",
  "created_at_ms",
  "updated_at_ms",
  "thread_source",
  "preview",
  "recency_at",
  "recency_at_ms",
  "history_mode",
  "name",
  "is_pinned",
  "thread_section_id",
  "section_position",
  "section_entered_at_ms",
  "project_id",
  "originator",
  "daybreak_enabled",
  "creator_user_id",
  "creator_account_id",
] as const;

const FLOOR_COLUMNS: readonly string[] = [...REQUIRED_THREAD_COLUMNS];

describe("Test 1: evaluateStoreShape keys on data shape, not the CLI version", () => {
  it("is ok with no optional columns on the floor shape", () => {
    expect(evaluateStoreShape({ migrationsTable: true, columns: FLOOR_COLUMNS })).toEqual({
      ok: true,
      optional: [],
      promptDerived: [],
    });
  });

  it("is ok with every optional column available on the full current shape", () => {
    const verdict = evaluateStoreShape({ migrationsTable: true, columns: CURRENT_COLUMNS });
    expect(verdict).toEqual({
      ok: true,
      optional: ["model", "reasoning_effort", "thread_source", "agent_nickname"],
      promptDerived: ["name", "title"],
    });
  });

  it("names the missing required column", () => {
    const columns = FLOOR_COLUMNS.filter((c) => c !== "updated_at_ms");
    expect(evaluateStoreShape({ migrationsTable: true, columns })).toEqual({
      ok: false,
      reason: "missing-column",
      column: "updated_at_ms",
    });
  });

  it("is not ok without the migrations table, whatever the columns", () => {
    expect(evaluateStoreShape({ migrationsTable: false, columns: CURRENT_COLUMNS })).toEqual({
      ok: false,
      reason: "no-migrations-table",
    });
  });

  it("reports every required column as a possible missing one", () => {
    for (const missing of REQUIRED_THREAD_COLUMNS) {
      const columns = FLOOR_COLUMNS.filter((c) => c !== missing);
      expect(evaluateStoreShape({ migrationsTable: true, columns })).toMatchObject({
        ok: false,
        column: missing,
      });
    }
  });
});

describe("Test 2: buildThreadsSelect is privacy-bounded by construction", () => {
  const shapes: [string, readonly string[]][] = [
    ["floor", FLOOR_COLUMNS],
    ["current", CURRENT_COLUMNS],
  ];

  function identifiersOf(sql: string): string[] {
    const match = /^SELECT (.+) FROM threads /.exec(sql);
    return match?.[1]?.split(", ") ?? [];
  }

  for (const [shapeName, columns] of shapes) {
    for (const includePromptDerived of [false, true]) {
      it(`${shapeName} columns, prompt flag ${includePromptDerived}: only allowlisted names and bound parameters`, () => {
        const built = buildThreadsSelect(columns, { includePromptDerived });
        expect(built.sql).not.toContain("*");
        for (const never of NEVER_SELECT_THREAD_COLUMNS) expect(built.sql).not.toContain(never);
        expect(built.sql).toMatch(/WHERE updated_at_ms > \? ORDER BY updated_at_ms DESC LIMIT \?$/);
        expect(built.bindOrder).toEqual(["sinceMs", "limit"]);

        const named = identifiersOf(built.sql);
        const allowed: readonly string[] = [
          ...REQUIRED_THREAD_COLUMNS,
          ...OPTIONAL_THREAD_COLUMNS,
          ...PROMPT_DERIVED_THREAD_COLUMNS,
        ];
        expect(named.length).toBeGreaterThan(0);
        for (const name of named) expect(allowed).toContain(name);
        expect(built.columns).toEqual(named);
        for (const required of REQUIRED_THREAD_COLUMNS) expect(named).toContain(required);

        const promptNamed = PROMPT_DERIVED_THREAD_COLUMNS.filter((c) => named.includes(c));
        const exists = PROMPT_DERIVED_THREAD_COLUMNS.filter((c) => columns.includes(c));
        expect(promptNamed).toEqual(includePromptDerived ? exists : []);
        const optionalNamed = OPTIONAL_THREAD_COLUMNS.filter((c) => named.includes(c));
        expect(optionalNamed).toEqual(OPTIONAL_THREAD_COLUMNS.filter((c) => columns.includes(c)));
      });
    }
  }

  it("never selects a never-select column, even when the table has them all", () => {
    for (const includePromptDerived of [false, true]) {
      const built = buildThreadsSelect(CURRENT_COLUMNS, { includePromptDerived });
      for (const never of NEVER_SELECT_THREAD_COLUMNS) {
        expect(built.columns).not.toContain(never);
      }
    }
  });

  it("throws when asked for a never-select column, even with the prompt flag on", () => {
    for (const never of NEVER_SELECT_THREAD_COLUMNS) {
      expect(() =>
        buildThreadsSelect(CURRENT_COLUMNS, { includePromptDerived: true, select: [never] }),
      ).toThrow(/never/i);
    }
  });

  it("throws when asked for a prompt-derived column without the flag, or an unknown one", () => {
    expect(() =>
      buildThreadsSelect(CURRENT_COLUMNS, { includePromptDerived: false, select: ["id", "title"] }),
    ).toThrow();
    expect(() =>
      buildThreadsSelect(CURRENT_COLUMNS, {
        includePromptDerived: false,
        select: ["id", "tokens_used"],
      }),
    ).toThrow();
  });

  it("honours an explicit select subset in order and omits an absent optional column", () => {
    const built = buildThreadsSelect(FLOOR_COLUMNS, {
      includePromptDerived: false,
      select: ["id", "updated_at_ms", "model"],
    });
    expect(built.columns).toEqual(["id", "updated_at_ms"]);
  });

  it("throws when a required column is absent from the table (the caller gates first)", () => {
    expect(() =>
      buildThreadsSelect(
        FLOOR_COLUMNS.filter((c) => c !== "cwd"),
        { includePromptDerived: false },
      ),
    ).toThrow();
  });
});

describe("Test 3: classifyThreadSource", () => {
  it("maps the plain sources", () => {
    expect(classifyThreadSource("cli")).toEqual({ origin: "interactive", visible: true });
    expect(classifyThreadSource("exec")).toEqual({ origin: "headless", visible: true });
    expect(classifyThreadSource("vscode")).toEqual({ origin: "editor", visible: true });
  });

  it("shows a review sub-agent and hides spawned and guardian children", () => {
    expect(classifyThreadSource('{"subagent":"review"}')).toEqual({
      origin: "review",
      visible: true,
    });
    expect(
      classifyThreadSource(
        '{"subagent":{"thread_spawn":{"parent_thread_id":"thread-x","depth":1}}}',
      ),
    ).toEqual({ origin: "spawned", visible: false });
    expect(classifyThreadSource('{"subagent":{"other":"guardian"}}')).toEqual({
      origin: "guardian",
      visible: false,
    });
  });

  it("hides null, empty, unknown and non-JSON values without throwing", () => {
    for (const value of [null, undefined, "", "   ", "mcp", "{not json", "42", 7, {}, []]) {
      expect(classifyThreadSource(value)).toEqual({ origin: "unknown", visible: false });
    }
    expect(classifyThreadSource('{"subagent":{"other":"somethingelse"}}')).toEqual({
      origin: "unknown",
      visible: false,
    });
  });

  it("survives hostile nested and oversized JSON", () => {
    const deep = `${'{"subagent":'.repeat(50_000)}"review"${"}".repeat(50_000)}`;
    expect(classifyThreadSource(deep)).toEqual({ origin: "unknown", visible: false });
    const nestedShort = `${'{"a":'.repeat(120)}1${"}".repeat(120)}`;
    expect(classifyThreadSource(nestedShort)).toEqual({ origin: "unknown", visible: false });
    expect(classifyThreadSource('{"subagent":"review","extra":"x"}')).toEqual({
      origin: "review",
      visible: true,
    });
    expect(classifyThreadSource(`{"subagent":"${"r".repeat(5000)}"}`)).toEqual({
      origin: "unknown",
      visible: false,
    });
  });
});

describe("Test 4: evaluateRolloutCanary (Assumption A17)", () => {
  const T = 1_791_000_000_000;
  const row = (i: number, mtimeOffset: number | null) => ({
    updatedAtMs: T - i * 60_000,
    rolloutMtimeMs: mtimeOffset === null ? null : T - i * 60_000 + mtimeOffset,
  });

  it("is ok when every recent thread's rollout is within the skew of its update time", () => {
    const rows = Array.from({ length: 8 }, (_, i) => row(i, -10_000));
    expect(evaluateRolloutCanary(rows)).toEqual({ verdict: "ok", sampled: 8, mismatched: 0 });
  });

  it("treats a rollout newer than the thread as fine", () => {
    expect(evaluateRolloutCanary([row(0, 120_000)]).verdict).toBe("ok");
  });

  it("is suspect when three of the eight newest have a missing or much older rollout", () => {
    const rows = [
      row(0, null),
      row(1, -3_600_000),
      row(2, null),
      ...Array.from({ length: 5 }, (_, i) => row(i + 3, 0)),
    ];
    expect(evaluateRolloutCanary(rows)).toEqual({ verdict: "suspect", sampled: 8, mismatched: 3 });
  });

  it("stays ok at two mismatches and judges only the eight newest", () => {
    const rows = [
      row(0, null),
      row(1, null),
      ...Array.from({ length: 6 }, (_, i) => row(i + 2, 0)),
    ];
    expect(evaluateRolloutCanary(rows).verdict).toBe("ok");
    const older = [
      ...Array.from({ length: 8 }, (_, i) => row(i, 0)),
      row(9, null),
      row(10, null),
      row(11, null),
    ];
    expect(evaluateRolloutCanary(older)).toEqual({ verdict: "ok", sampled: 8, mismatched: 0 });
  });

  it("sorts by update time itself and is ok on no rows", () => {
    const shuffled = [row(5, 0), row(0, null), row(7, 0), row(1, null), row(2, null), row(3, 0)];
    expect(evaluateRolloutCanary(shuffled).verdict).toBe("suspect");
    expect(evaluateRolloutCanary([])).toEqual({ verdict: "ok", sampled: 0, mismatched: 0 });
  });
});
