import { describe, expect, it } from "vitest";
import {
  rolloutContent,
  rolloutLifecycleLine,
  rolloutMetaLine,
  rolloutUnknownLine,
} from "../test-support/fake-codex-home.js";
import {
  FIRST_SIGHT_BYTES,
  type RolloutTailEntry,
  type RolloutTailPort,
  readRolloutTail,
} from "./rollout-tail.js";

const REF = { path: "/Users/USERNAME/.codex/sessions/2026/10/06/rollout-synthetic.jsonl" };
const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);

/** An in-memory rollout: the port records every range it is asked for. */
function memoryPort(initial: string | Buffer) {
  const state = {
    content: Buffer.from(initial),
    mtimeMs: T0,
    missing: false,
    reads: [] as Array<{ offset: number; maxBytes: number; returned: number }>,
  };
  const port: RolloutTailPort = {
    statRollout() {
      return state.missing ? null : { size: state.content.length, mtimeMs: state.mtimeMs };
    },
    readRolloutRange(_ref, offset, maxBytes) {
      const bytes = state.content.subarray(offset, offset + maxBytes);
      state.reads.push({ offset, maxBytes, returned: bytes.length });
      return { bytes: Buffer.from(bytes), size: state.content.length };
    },
  };
  return { state, port };
}

function ok(result: ReturnType<typeof readRolloutTail>) {
  if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
  return result;
}

describe("Test 3: the rollout tail reader is bounded and incremental", () => {
  it("reads a small rollout whole on first sight and retains the last lifecycle fact", () => {
    const { port, state } = memoryPort(
      rolloutContent(
        rolloutMetaLine({ id: "t1", atMs: T0 }),
        rolloutLifecycleLine("task_started", T0 + 1000),
      ),
    );
    const result = ok(readRolloutTail(port, REF, undefined));
    expect(result.fresh).toBe(true);
    expect(result.caughtUp).toBe(true);
    expect(state.reads).toHaveLength(1);
    expect(state.reads[0]?.offset).toBe(0);
    const last = result.entry.retained.at(-1);
    expect(last).toMatchObject({ kind: "lifecycle", event: "task_started" });
    expect(result.entry.lines).toBe(2);
    expect(result.entry.recognized).toBe(2);
  });

  it("reads only the last 256 KiB of a large rollout on first sight, skipping the partial first line", () => {
    const filler = rolloutUnknownLine(T0);
    const lines: string[] = [];
    let size = 0;
    while (size < 1024 * 1024) {
      lines.push(filler);
      size += filler.length + 1;
    }
    lines.push(rolloutLifecycleLine("task_complete", T0 + 5000));
    const { port, state } = memoryPort(rolloutContent(...lines));
    const result = ok(readRolloutTail(port, REF, undefined));
    expect(state.reads).toHaveLength(1);
    const read = state.reads[0];
    expect(read?.maxBytes).toBe(FIRST_SIGHT_BYTES);
    expect(read?.offset).toBe(state.content.length - FIRST_SIGHT_BYTES);
    expect(result.entry.retained.at(-1)).toMatchObject({
      kind: "lifecycle",
      event: "task_complete",
    });
    // The partial first line was dropped, so every examined line is complete.
    expect(result.entry.lines).toBeLessThan(lines.length);
    expect(result.entry.recognized).toBe(1);
  });

  it("resumes from the cursor and reads only the new bytes", () => {
    const first = rolloutContent(rolloutMetaLine({ id: "t1", atMs: T0 }));
    const { port, state } = memoryPort(first);
    const one = ok(readRolloutTail(port, REF, undefined));
    state.content = Buffer.concat([
      state.content,
      Buffer.from(rolloutContent(rolloutLifecycleLine("task_started", T0 + 1000))),
    ]);
    state.reads.length = 0;
    const two = ok(readRolloutTail(port, REF, one.entry));
    expect(two.fresh).toBe(false);
    expect(state.reads).toHaveLength(1);
    expect(state.reads[0]?.offset).toBe(first.length);
    expect(two.entry.retained.at(-1)).toMatchObject({ kind: "lifecycle", event: "task_started" });
    expect(two.entry.lines).toBe(2);
  });

  it("makes no read at all when the file has not grown", () => {
    const { port, state } = memoryPort(rolloutContent(rolloutMetaLine({ id: "t1", atMs: T0 })));
    const one = ok(readRolloutTail(port, REF, undefined));
    state.reads.length = 0;
    const two = ok(readRolloutTail(port, REF, one.entry));
    expect(state.reads).toHaveLength(0);
    expect(two.bytesRead).toBe(0);
    expect(two.entry).toBe(one.entry);
  });

  it("carries a partial line across polls", () => {
    const whole = rolloutContent(
      rolloutMetaLine({ id: "t1", atMs: T0 }),
      rolloutLifecycleLine("turn_aborted", T0 + 1000),
    );
    const cut = whole.length - 20;
    const { port, state } = memoryPort(whole.slice(0, cut));
    const one = ok(readRolloutTail(port, REF, undefined));
    expect(one.entry.retained.some((fact) => fact.kind === "lifecycle")).toBe(false);
    state.content = Buffer.from(whole);
    const two = ok(readRolloutTail(port, REF, one.entry));
    expect(two.entry.retained.at(-1)).toMatchObject({ kind: "lifecycle", event: "turn_aborted" });
  });

  it("caps the bytes of one call and reports not caught up", () => {
    const line = rolloutUnknownLine(T0);
    const content = rolloutContent(...Array.from({ length: 200 }, () => line));
    const { port } = memoryPort(content);
    const result = ok(
      readRolloutTail(port, REF, undefined, { firstSightBytes: 10_000_000, maxBytes: 1000 }),
    );
    expect(result.bytesRead).toBeLessThanOrEqual(1000);
    expect(result.caughtUp).toBe(false);
    const more = ok(readRolloutTail(port, REF, result.entry, { maxBytes: 1000 }));
    expect(more.entry.readTo).toBeGreaterThan(result.entry.readTo);
  });

  it("treats a shrunk file as a fresh first sight", () => {
    const { port, state } = memoryPort(
      rolloutContent(
        rolloutMetaLine({ id: "t1", atMs: T0 }),
        rolloutLifecycleLine("task_started", T0 + 1000),
      ),
    );
    const one = ok(readRolloutTail(port, REF, undefined));
    state.content = Buffer.from(rolloutContent(rolloutLifecycleLine("task_complete", T0 + 2000)));
    const two = ok(readRolloutTail(port, REF, one.entry));
    expect(two.fresh).toBe(true);
    expect(two.entry.retained.at(-1)).toMatchObject({ kind: "lifecycle", event: "task_complete" });
  });

  it("treats a file whose modification time went backwards as a fresh first sight", () => {
    const { port, state } = memoryPort(rolloutContent(rolloutLifecycleLine("task_started", T0)));
    const one = ok(readRolloutTail(port, REF, undefined));
    state.mtimeMs = T0 - 60_000;
    state.content = Buffer.from(
      rolloutContent(
        rolloutLifecycleLine("task_complete", T0 - 90_000),
        rolloutLifecycleLine("task_started", T0 - 80_000),
        rolloutLifecycleLine("task_complete", T0 - 70_000),
      ),
    );
    const two = ok(readRolloutTail(port, REF, one.entry));
    expect(two.fresh).toBe(true);
    expect(two.entry.retained.at(-1)).toMatchObject({ kind: "lifecycle", event: "task_complete" });
  });

  it("answers missing, failed and deferred without throwing", () => {
    const { port, state } = memoryPort("");
    state.missing = true;
    expect(readRolloutTail(port, REF, undefined)).toEqual({ kind: "missing" });
    state.missing = false;
    state.content = Buffer.from(rolloutContent(rolloutMetaLine({ id: "t1", atMs: T0 })));
    expect(readRolloutTail(port, REF, undefined, { maxBytes: 0 })).toEqual({ kind: "deferred" });
    const throwing: RolloutTailPort = {
      statRollout: () => {
        throw new Error("synthetic /Users/USERNAME/secret path");
      },
      readRolloutRange: () => {
        throw new Error("never");
      },
    };
    expect(readRolloutTail(throwing, REF, undefined)).toEqual({ kind: "failed" });
  });

  it("keeps a limit-hit that follows the last lifecycle event and drops one that precedes it", () => {
    const limitLine = JSON.stringify({
      type: "event_msg",
      timestamp: new Date(T0).toISOString(),
      payload: { type: "error", message: "You hit a usage limit" },
    });
    const { port } = memoryPort(
      rolloutContent(limitLine, rolloutLifecycleLine("task_started", T0 + 1000), limitLine),
    );
    const result = ok(readRolloutTail(port, REF, undefined));
    expect(result.entry.retained.map((fact) => fact.kind)).toEqual(["lifecycle", "limit-hit"]);
    const prior = memoryPort(
      rolloutContent(limitLine, rolloutLifecycleLine("task_started", T0 + 1000)),
    );
    const second = ok(readRolloutTail(prior.port, REF, undefined));
    expect(second.entry.retained.map((fact) => fact.kind)).toEqual(["lifecycle"]);
  });
});

describe("retained facts stay small", () => {
  it("never keeps more than a lifecycle fact and one limit-hit however long the rollout", () => {
    const lines: string[] = [];
    for (let i = 0; i < 500; i += 1)
      lines.push(rolloutLifecycleLine("task_started", T0 + i, `turn-${i}`));
    const { port } = memoryPort(rolloutContent(...lines));
    const entry: RolloutTailEntry = ok(readRolloutTail(port, REF, undefined)).entry;
    expect(entry.retained.length).toBeLessThanOrEqual(2);
  });
});
