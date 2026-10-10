import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApprovalSummary } from "@ccc/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createApprovalNotifier,
  createWebNotification,
  decideNotification,
  NOTIFY_GRACE_MS,
  NOTIFY_NOTICE_TEXT,
  NOTIFY_TITLE,
  type NotificationHandle,
  type NotifyDeps,
  type NotifyFacts,
  notificationContent,
} from "./notify.js";

const LOADED_AT = Date.parse("2026-10-06T12:00:00.000Z");
const ID = "abcdefghij0123456789abcde";

function summary(overrides: Partial<ApprovalSummary> = {}): ApprovalSummary {
  return {
    proposalId: ID as ApprovalSummary["proposalId"],
    state: "pending",
    revision: 1,
    title: "Force-terminate session ccc-secret-run",
    operationLabel: "Force-terminate a Claude session",
    requesterKind: "skill",
    requesterLabel: "Daily digest",
    projectName: null,
    runId: null,
    createdAt: new Date(LOADED_AT + 1000).toISOString(),
    expiresAt: new Date(LOADED_AT + 3_600_000).toISOString(),
    decidedAt: null,
    outcomeCode: null,
    ...overrides,
  };
}

function facts(overrides: Partial<NotifyFacts> = {}): NotifyFacts {
  return {
    enabled: true,
    focused: false,
    sectionVisible: false,
    state: "pending",
    createdAtMs: LOADED_AT + 1000,
    loadedAtMs: LOADED_AT,
    graceMs: NOTIFY_GRACE_MS,
    alreadySeen: false,
    ...overrides,
  };
}

interface Harness {
  deps: NotifyDeps;
  notices: string[];
  created: { title: string; options: unknown; handle: NotificationHandle }[];
  calls: string[];
  state: { enabled: boolean; focused: boolean; visible: boolean };
}

function harness(overrides: Partial<NotifyDeps> = {}): Harness {
  const notices: string[] = [];
  const created: Harness["created"] = [];
  const calls: string[] = [];
  const state = { enabled: true, focused: false, visible: false };
  const deps: NotifyDeps = {
    enabled: () => state.enabled,
    appFocused: () => state.focused,
    approvalsVisible: () => state.visible,
    notice: (message) => {
      notices.push(message);
    },
    create: (title, options) => {
      const handle: NotificationHandle = { onclick: null };
      created.push({ title, options, handle });
      return handle;
    },
    focusWindow: () => {
      calls.push("focus");
    },
    select: (id) => {
      calls.push(`select:${id}`);
    },
    now: () => LOADED_AT,
    loadedAt: LOADED_AT,
    ...overrides,
  };
  return { deps, notices, created, calls, state };
}

describe("decideNotification (plan 06-09, D-26, UI-SPEC notification)", () => {
  it("unfocused gives native, focused with the section hidden gives notice, focused and showing gives none", () => {
    expect(decideNotification(facts({ focused: false }))).toBe("native");
    expect(decideNotification(facts({ focused: true, sectionVisible: false }))).toBe("notice");
    expect(decideNotification(facts({ focused: true, sectionVisible: true }))).toBe("none");
  });

  it("with notifications off, unfocused gives none but a focused hidden case still gives a notice", () => {
    expect(decideNotification(facts({ enabled: false, focused: false }))).toBe("none");
    expect(
      decideNotification(facts({ enabled: false, focused: true, sectionVisible: false })),
    ).toBe("notice");
    expect(decideNotification(facts({ enabled: false, focused: true, sectionVisible: true }))).toBe(
      "none",
    );
  });

  it("gives none for anything that is not a new pending request", () => {
    for (const state of ["approved", "denied", "expired", "executing", "executed"] as const) {
      expect(decideNotification(facts({ state }))).toBe("none");
      expect(decideNotification(facts({ state, focused: true }))).toBe("none");
    }
    expect(decideNotification(facts({ alreadySeen: true }))).toBe("none");
    expect(decideNotification(facts({ alreadySeen: true, focused: true }))).toBe("none");
  });

  it("gives none for a request created before the plugin loaded, past the grace window", () => {
    expect(decideNotification(facts({ createdAtMs: LOADED_AT - NOTIFY_GRACE_MS - 1 }))).toBe(
      "none",
    );
    expect(decideNotification(facts({ createdAtMs: LOADED_AT - NOTIFY_GRACE_MS }))).toBe("native");
    expect(decideNotification(facts({ createdAtMs: Number.NaN }))).toBe("none");
  });
});

describe("the notifier decides what is new (plan 06-09, D-11, Pitfall 10)", () => {
  it("raises nothing for a decided, an expired or a replayed request", () => {
    const h = harness();
    const notify = createApprovalNotifier(h.deps);

    notify(summary({ state: "approved" }));
    notify(summary({ state: "expired" }));
    expect(h.created).toHaveLength(0);
    expect(h.notices).toHaveLength(0);

    notify(summary());
    notify(summary());
    notify(summary({ revision: 2 }));
    expect(h.created).toHaveLength(1);
  });

  it("raises nothing for a pending request created before the plugin loaded", () => {
    const h = harness();
    const notify = createApprovalNotifier(h.deps);

    notify(summary({ createdAt: new Date(LOADED_AT - 60_000).toISOString() }));

    expect(h.created).toHaveLength(0);
    expect(h.notices).toHaveLength(0);
  });

  it("a request that becomes decided after it was notified raises nothing more", () => {
    const h = harness();
    const notify = createApprovalNotifier(h.deps);

    notify(summary());
    notify(summary({ state: "approved", revision: 2 }));

    expect(h.created).toHaveLength(1);
  });

  it("a second notifier built with a later load time suppresses a snapshot replay of earlier requests", () => {
    const first = harness();
    const second = harness({ loadedAt: LOADED_AT + 600_000, now: () => LOADED_AT + 600_000 });
    const early = summary();

    createApprovalNotifier(first.deps)(early);
    createApprovalNotifier(second.deps)(early);

    expect(first.created).toHaveLength(1);
    expect(second.created).toHaveLength(0);
    expect(second.notices).toHaveLength(0);
  });

  it("defaults the load time to the injected clock at construction", () => {
    const h = harness({ now: () => LOADED_AT + 600_000 });
    const { loadedAt: _ignored, ...withoutLoadedAt } = h.deps;
    createApprovalNotifier(withoutLoadedAt)(summary());
    expect(h.created).toHaveLength(0);
  });

  it("follows the focus and visibility facts at the moment of the upsert", () => {
    const h = harness();
    const notify = createApprovalNotifier(h.deps);

    h.state.focused = true;
    h.state.visible = true;
    notify(summary({ proposalId: "aaaaaaaaaa0000000000aaaaa" as ApprovalSummary["proposalId"] }));
    expect(h.created).toHaveLength(0);
    expect(h.notices).toHaveLength(0);

    h.state.visible = false;
    notify(summary({ proposalId: "bbbbbbbbbb0000000000bbbbb" as ApprovalSummary["proposalId"] }));
    expect(h.notices).toEqual([NOTIFY_NOTICE_TEXT]);
    expect(h.created).toHaveLength(0);

    h.state.focused = false;
    notify(summary({ proposalId: "ccccccccc00000000000ccccc" as ApprovalSummary["proposalId"] }));
    expect(h.created).toHaveLength(1);
  });
});

describe("notificationContent (APPR-09, T-06-10)", () => {
  it("has the fixed title and a body of the requester and the templated action", () => {
    const content = notificationContent(summary());
    expect(NOTIFY_TITLE).toBe("Approval needed");
    expect(content.title).toBe("Approval needed");
    expect(content.body).toBe("Daily digest asks to force-terminate a Claude session.");
    expect(content.tag).toBe(ID);
  });

  it("says The dashboard for the dashboard kind whatever its label says", () => {
    const content = notificationContent(
      summary({
        requesterKind: "dashboard",
        requesterLabel: "Claude command center",
        operationLabel: "Run a test that does nothing",
      }),
    );
    expect(content.body).toBe("The dashboard asks to run a test that does nothing.");
  });

  it("strips control, format and bidi characters from the label and cuts it to 40 characters", () => {
    const hostile = `Dai\u0000ly\u202E digest\u200B\u2028 ${"x".repeat(80)}`;
    const content = notificationContent(summary({ requesterLabel: hostile }));
    const requester = content.body.split(" asks to ")[0] ?? "";
    expect(requester).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect([...requester].length).toBeLessThanOrEqual(40);
    expect(requester.startsWith("Daily digest")).toBe(true);
  });

  it("falls back to a kind-based requester when nothing visible is left of the label", () => {
    const content = notificationContent(summary({ requesterLabel: "\u200B\u202E" }));
    expect(content.body).toBe("A skill asks to force-terminate a Claude session.");
  });

  it("uses a generic action for an operation the table did not know", () => {
    const content = notificationContent(summary({ operationLabel: "Unknown request" }));
    expect(content.body).toBe("Daily digest asks to make a request.");
  });

  it("leaves none of a target, project, run, reason, payload or path in the title or body", () => {
    const hostile = summary({
      title: "Terminate TARGET-SESSION-NAME in /Users/USERNAME/secret-project",
      projectName: "PRIVATE-PROJECT",
      runId: "RUNID0123456789abcdefghi" as ApprovalSummary["runId"],
      outcomeCode: "PAYLOAD-WORDS",
    });
    const { title, body } = notificationContent(hostile);
    const text = `${title}\n${body}`;
    for (const leaked of [
      "TARGET-SESSION-NAME",
      "PRIVATE-PROJECT",
      "RUNID0123456789abcdefghi",
      "PAYLOAD-WORDS",
      "/Users/",
      "secret-project",
    ]) {
      expect(text).not.toContain(leaked);
    }
  });
});

describe("the notification shape and its click (APPR-09, T-06-13)", () => {
  it("passes the constructor only a body, a tag equal to the proposal id and silent false", () => {
    const h = harness();
    createApprovalNotifier(h.deps)(summary());

    expect(h.created).toHaveLength(1);
    const first = h.created[0];
    expect(first?.title).toBe("Approval needed");
    expect(first?.options).toStrictEqual({
      body: "Daily digest asks to force-terminate a Claude session.",
      tag: ID,
      silent: false,
    });
    expect(Object.keys(first?.options as object).sort()).toEqual(["body", "silent", "tag"]);
    expect(first?.options).not.toHaveProperty("actions");
    expect(first?.options).not.toHaveProperty("icon");
  });

  it("the click focuses the window then selects the request, once, and does nothing else", () => {
    const h = harness();
    createApprovalNotifier(h.deps)(summary());
    const handle = h.created[0]?.handle;

    expect(handle?.onclick).toBeTypeOf("function");
    handle?.onclick?.();

    expect(h.calls).toEqual(["focus", `select:${ID}`]);
    expect(h.notices).toHaveLength(0);
  });

  it("neither the notifier nor the web notification helper imports a client or a decide path", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "notify.ts"), "utf8");
    const specifiers = [...source.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((m) => m[1]);
    for (const specifier of specifiers) {
      expect(specifier).toBe("@ccc/domain");
    }
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/service-api-client|approvals-client|\.request\s*\(/);
  });
});

describe("robustness (plan 06-09, spike S7)", () => {
  const NOTICE =
    'Approval needed. Run "Open approval inbox" from the command palette to review it.';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the exact fallback notice text", () => {
    expect(NOTIFY_NOTICE_TEXT).toBe(NOTICE);
  });

  it("falls back to a notice when the constructor yields nothing", () => {
    const h = harness({ create: () => null });
    expect(() => createApprovalNotifier(h.deps)(summary())).not.toThrow();
    expect(h.notices).toEqual([NOTICE]);
  });

  it("falls back to a notice when create throws, and never throws itself", () => {
    const h = harness({
      create: () => {
        throw new Error("no notifications here");
      },
    });
    expect(() => createApprovalNotifier(h.deps)(summary())).not.toThrow();
    expect(h.notices).toEqual([NOTICE]);
  });

  it("never throws even when the notice itself throws", () => {
    const h = harness({
      create: () => null,
      notice: () => {
        throw new Error("no notice either");
      },
    });
    expect(() => createApprovalNotifier(h.deps)(summary())).not.toThrow();
  });

  it("createWebNotification returns null when Notification is unavailable", () => {
    vi.stubGlobal("Notification", undefined);
    expect(createWebNotification("t", { body: "b", tag: "x", silent: false })).toBeNull();
  });

  it("createWebNotification returns null when permission is denied and never constructs", () => {
    const ctor = vi.fn();
    vi.stubGlobal("Notification", Object.assign(ctor, { permission: "denied" }));
    expect(createWebNotification("t", { body: "b", tag: "x", silent: false })).toBeNull();
    expect(ctor).not.toHaveBeenCalled();
  });

  it("createWebNotification returns null when the constructor throws", () => {
    class Throwing {
      static permission = "granted";
      constructor() {
        throw new Error("illegal constructor");
      }
    }
    vi.stubGlobal("Notification", Throwing);
    expect(createWebNotification("t", { body: "b", tag: "x", silent: false })).toBeNull();
  });

  it("createWebNotification wires onclick through to the real notification", () => {
    const instances: { onclick: (() => void) | null }[] = [];
    class Fake {
      static permission = "granted";
      onclick: (() => void) | null = null;
      constructor(
        readonly title: string,
        readonly options: unknown,
      ) {
        instances.push(this);
      }
    }
    vi.stubGlobal("Notification", Fake);

    const handle = createWebNotification("t", { body: "b", tag: "x", silent: false });
    const clicked = vi.fn();
    expect(handle).not.toBeNull();
    if (handle !== null) handle.onclick = clicked;
    instances[0]?.onclick?.();

    expect(clicked).toHaveBeenCalledTimes(1);
  });
});
