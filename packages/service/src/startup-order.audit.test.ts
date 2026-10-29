import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Audit (05-16 merge reconcile, area 6, D-22): the merged `main.ts` must start
 * in one fixed order. A second instance refuses before touching anything
 * (claim), Phase 4's stale-script sweep and the store/migrations run next,
 * SVC-11 recovery precedes every consumer of run rows, the approved roots are
 * recomputed from the store, only then do the Claude and usage services start,
 * and the listener and socket come last.
 */
describe("main.ts startup order (D-22)", () => {
  const src = readFileSync(fileURLToPath(new URL("./main.ts", import.meta.url)), "utf8");

  const STEPS = [
    "await claimSocketPath(socketPath)",
    "sweepStaleScripts(scriptDir",
    // Plan 07-14: the research test overrides are resolved (and an unusable one refuses) before
    // the store is touched.
    "resolveResearchTestOverrides(process.env",
    "openStore(dbPath)",
    "recoverInterruptedRuns(store.db",
    "recomputeApprovedRoots(store)",
    "await startClaudeServices(",
    "startUsageServices({",
    // Phase 05.1: the Codex detection is built for the detector in the launcher block.
    "createCodexDetection({",
    "startApprovalServices({",
    "await approvals.recover()",
    "approvals.start()",
    "claudeServices.proposerSlot.bind(",
    "createTaskServices({",
    "taskHost.startupWalk()",
    // Phase 05.1: after the usage services and the task block, before the listener (D-14).
    "await startCodexServices(",
    // Plan 07-14: the listener holds a late-bound research slot; the research services are built
    // only after the socket is bound (an instance that lost the bind must never sweep a live run).
    "createResearchRouteSlot()",
    // Plan 08-07: the diagnostics services are built from narrow ports before the listener.
    "createDiagnosticsServices({",
    "createRequestListener({",
    "await startSocketServer({",
    "createResearchServices({",
    "researchSlot.bind(",
    // The timers of both start only once the socket is open.
    "usageServices.start()",
    "codexServices.start()",
  ] as const;

  it("calls each startup step exactly once in the documented order", () => {
    const positions = STEPS.map((step) => {
      const first = src.indexOf(step);
      expect(first, `${step} must appear in main.ts`).toBeGreaterThan(-1);
      expect(src.indexOf(step, first + 1), `${step} must appear once`).toBe(-1);
      return first;
    });
    for (let i = 1; i < positions.length; i += 1) {
      const earlier = positions[i - 1] as number;
      const later = positions[i] as number;
      expect(later, `${STEPS[i - 1]} must precede ${STEPS[i]}`).toBeGreaterThan(earlier);
    }
  });
});

/**
 * Audit (plan 06-21 Task 3, Tests 2 and 8, D-09): the shutdown chain stops the
 * expiry sweeper first and waits for in-flight executions, then the usage and
 * Claude services, then closes the store; a second signal does nothing; and
 * the object handed to the route context exposes no terminator or executor.
 */
describe("main.ts shutdown order (D-09)", () => {
  const src = readFileSync(fileURLToPath(new URL("./main.ts", import.meta.url)), "utf8");
  const shutdownAt = src.indexOf("const shutdown = ");
  const body = src.slice(shutdownAt);

  it("stops the approvals, then Codex, then the usage services, then the Claude services, then closes the store", () => {
    expect(shutdownAt).toBeGreaterThan(-1);
    const needles: [string, RegExp][] = [
      ["approvals.stop()", /approvals\s*\.stop\(\)/],
      ["codexServices.stop()", /codexServices\.stop\(\)/],
      ["usageServices.stop()", /usageServices\.stop\(\)/],
      ["claudeServices.stop()", /claudeServices\.stop\(\)/],
      ["store.close()", /store\.close\(\)/],
    ];
    const order = needles.map(([label, pattern]) => {
      const at = body.search(pattern);
      expect(at, `${label} must appear in the shutdown chain`).toBeGreaterThan(-1);
      return at;
    });
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i] as number).toBeGreaterThan(order[i - 1] as number);
    }
  });

  it("disposes the task services and ignores a second signal", () => {
    expect(body).toContain("taskHost.dispose()");
    const shutdownSrc = readFileSync(
      fileURLToPath(new URL("./shutdown.ts", import.meta.url)),
      "utf8",
    );
    expect(shutdownSrc).toMatch(/if \(shuttingDown\) return;/);
  });

  it("hands the route context no terminator, executor or process facts", () => {
    const start = src.indexOf("createRequestListener({");
    const end = src.indexOf("await startSocketServer({");
    const literal = src.slice(start, end);
    expect(literal).not.toMatch(/terminator|executor|processFacts|runInspector|proposerSlot/);
    expect(literal).toContain("approvals: approvals.services");
    // Phase 05.1: the Codex route deps only, never the services object's other members.
    expect(literal).toContain("codex: codexServices.routeDeps");
  });
});

/**
 * Audit (plan 05.1-28, Task 3): the Phase 05.1 blocks of `main.ts` add no timer of their own, name
 * the Codex detection for the detector, and carry the launcher-change and usage hooks.
 */
describe("main.ts Phase 05.1 blocks", () => {
  const src = readFileSync(fileURLToPath(new URL("./main.ts", import.meta.url)), "utf8");

  function block(start: string, end: string): string {
    const from = src.indexOf(start);
    const to = src.indexOf(end, from);
    expect(from, `${start} must be in main.ts`).toBeGreaterThan(-1);
    expect(to, `${end} must follow ${start}`).toBeGreaterThan(from);
    return src.slice(from, to);
  }

  it("adds no top-level timer in the Codex start block or the Codex detection", () => {
    const startBlock = block(
      ">>> Phase 05.1 (Codex services) start",
      "<<< Phase 05.1 (Codex services) end",
    );
    expect(startBlock).toContain("await startCodexServices(");
    expect(startBlock).not.toMatch(/setInterval|setTimeout|setImmediate/);
    const detectionBlock = block(
      ">>> Phase 05.1 (Codex detection) start",
      "<<< Phase 05.1 (Codex detection) end",
    );
    expect(detectionBlock).not.toMatch(/setInterval|setTimeout|setImmediate/);
  });

  it("hands the detector the Codex detection and the same detection to the services", () => {
    expect(src).toMatch(/createDetector\(\{[^}]*codex: codexDetection/s);
    expect(src).toMatch(/startCodexServices\(\{[^}]*detection: codexDetection/s);
  });

  it("binds the Phase 5 hooks and the launcher-change hook to the Codex services", () => {
    expect(src).toContain("deleteAnalytics: deleteAllUsageAnalytics");
    expect(src).toMatch(
      /onAnalysisChanged: \(change\) => codexSlot\.current\?\.onAnalysisChanged\(change\)/,
    );
    expect(src).toMatch(
      /onIntegrationRefresh: \(\) => codexSlot\.current\?\.onIntegrationRefresh\(\)/,
    );
    expect(src).toMatch(/codexSlot\.current\?\.onLaunchersChanged\(\)/);
  });
});

/**
 * Audit (plan 07-14, wave 4 review): the research services are constructed exactly once per
 * process, after the migrations, the run recovery and the socket bind; the key is read through a
 * closure; shutdown waits a bounded time for a run in flight between the Codex and usage services.
 */
describe("main.ts research wiring (plan 07-14)", () => {
  const src = readFileSync(fileURLToPath(new URL("./main.ts", import.meta.url)), "utf8");

  it("constructs the research services after recovery and the bound socket, never in the listener literal", () => {
    const at = src.indexOf("createResearchServices({");
    expect(at).toBeGreaterThan(src.indexOf("recoverInterruptedRuns(store.db"));
    expect(at).toBeGreaterThan(src.indexOf("await startSocketServer({"));
    const listener = src.slice(
      src.indexOf("createRequestListener({"),
      src.indexOf("await startSocketServer({"),
    );
    expect(listener).not.toContain("createResearchServices");
    expect(listener).toContain("research: researchSlot.services");
  });

  it("hands the research services a key-reading closure, the safe fetcher and an injected chooser", () => {
    const start = src.indexOf("createResearchServices({");
    const block = src.slice(start, src.indexOf("researchSlot.bind(", start));
    expect(block).toContain("readApiKey: () => secretStore.get(researchKeyAccount)");
    expect(block).toContain("researchOverrides.fetcher ?? createSafeFetcher()");
    expect(block).toContain("createChooseSummariser({");
    expect(src).toContain("researchOverrides.keyAccount ?? RESEARCH_API_KEY_ACCOUNT");
    // No key string is ever held in main.ts: the account is a name, the read is a closure.
    expect(src).not.toMatch(/apiKey\s*=|const key\b/);
  });

  it("stops research intake synchronously in stopIntake, before anything is awaited", () => {
    const at = src.indexOf("stopIntake: () => {");
    const block = src.slice(at, src.indexOf("},", at));
    expect(block).toContain("research.beginShutdown()");
  });

  it("binds the route slot once and waits for a run in the shutdown chain", () => {
    expect(src.match(/researchSlot\.bind\(/g)).toHaveLength(1);
    const shutdownAt = src.indexOf("const shutdown = ");
    const body = src.slice(shutdownAt);
    const order = [
      body.search(/codexServices\.stop\(\)/),
      body.search(/stopResearch: \(\) => research\.idle\(\)/),
      body.search(/usageServices\.stop\(\)/),
    ];
    expect(order[0]).toBeGreaterThan(-1);
    expect(order[1]).toBeGreaterThan(order[0] as number);
    expect(order[2]).toBeGreaterThan(order[1] as number);
  });
});

/**
 * Audit (09-FIX8, M6, D-03, T-09-37): the approval decision-proof key is derived exactly once, right after the
 * install secret is read, unguarded (so a secret under 32 bytes stops startup with the RangeError), and the
 * derived key reaches only `startApprovalServices`.
 */
describe("main.ts approval proof key derivation (D-03)", () => {
  const src = readFileSync(fileURLToPath(new URL("./main.ts", import.meta.url)), "utf8");

  it("derives the key once, directly after getInstallSecret, outside any try block", () => {
    const calls = src.match(/approvalProofKey\(/g) ?? [];
    expect(calls).toHaveLength(1);
    const secretAt = src.indexOf("await getInstallSecret(");
    const keyAt = src.indexOf("approvalProofKey(installSecret)");
    expect(secretAt).toBeGreaterThan(-1);
    expect(keyAt).toBeGreaterThan(secretAt);
    // Nothing but comments and blank lines between the two statements.
    const between = src
      .slice(src.indexOf("\n", secretAt), src.lastIndexOf("\n", keyAt))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("//"));
    expect(between).toEqual([]);
    // Not wrapped in a try/catch that could swallow the RangeError.
    const lineStart = src.lastIndexOf("\n", keyAt) + 1;
    expect(src.slice(lineStart, keyAt)).toMatch(/^\s*const approvalDecisionProofKey = $/);
  });

  it("hands the derived key to startApprovalServices and to nothing else", () => {
    const uses = src.match(/approvalDecisionProofKey/g) ?? [];
    // The declaration and the one `proofKey:` property of startApprovalServices.
    expect(uses).toHaveLength(2);
    expect(src).toMatch(/proofKey: approvalDecisionProofKey,/);
    const startAt = src.indexOf("startApprovalServices({");
    const keyUse = src.indexOf("proofKey: approvalDecisionProofKey,");
    expect(keyUse).toBeGreaterThan(startAt);
    expect(keyUse).toBeLessThan(src.indexOf("await approvals.recover()"));
  });
});

describe("main.ts wires the presence helper and the pin reader (09-18 Task 3)", () => {
  const src = readFileSync(fileURLToPath(new URL("./main.ts", import.meta.url)), "utf8");

  it("builds the port from the environment and the pin reader from the environment, once each, and hands both to the approval services", () => {
    expect(src.match(/presencePortFromEnv\(/g) ?? []).toHaveLength(1);
    expect(src.match(/pinReaderFromEnv\(/g) ?? []).toHaveLength(1);
    expect(src.match(/guardPinReader\(/g) ?? []).toHaveLength(1);
    // The port gets process.env, so a sandbox service (CCC_INSTALL_SECRET_ACCOUNT) is fail-closed.
    expect(src).toMatch(/presencePortFromEnv\(process\.env, runtimeDir,/);
    expect(src).toMatch(/read: pinReaderFromEnv\(process\.env, readItemComment\),/);
    const startAt = src.indexOf("startApprovalServices({");
    const recoverAt = src.indexOf("await approvals.recover()");
    for (const needle of ["presence: presencePort,", "readPin: presencePinReader,"]) {
      const at = src.indexOf(needle);
      expect(at, needle).toBeGreaterThan(startAt);
      expect(at, needle).toBeLessThan(recoverAt);
    }
    // Built before the approval services, never after them.
    expect(src.indexOf("presencePortFromEnv(")).toBeLessThan(startAt);
    expect(src.indexOf("guardPinReader(")).toBeLessThan(startAt);
  });

  it("09-FIX9: one guarded pin read at service start, after the store opens and before recovery, makes boot the trust-on-first-use point and the install window", () => {
    const openAt = src.indexOf("openStore(");
    const readAt = src.indexOf("await presencePinReader()");
    const startAt = src.indexOf("startApprovalServices({");
    const recoverAt = src.indexOf("await approvals.recover()");
    expect(src.match(/await presencePinReader\(\)/g) ?? []).toHaveLength(1);
    expect(readAt).toBeGreaterThan(openAt);
    expect(readAt).toBeGreaterThan(src.indexOf("guardPinReader("));
    expect(readAt).toBeLessThan(startAt);
    expect(readAt).toBeLessThan(recoverAt);
  });

  it("09-FIX9: the install marker is the time-bound, regular-file-only one", () => {
    expect(src).toMatch(/installMarker: createInstallMarker\(\{/);
    expect(src).toMatch(/maxAgeMs: PRESENCE_PIN_INSTALL_MARKER_MAX_AGE_MS/);
    expect(src).not.toMatch(/present: \(\) => existsSync/);
  });

  it("reads the pin item only through the guarded reader: no other call of readItemComment", () => {
    const calls = (src.match(/readItemComment\b/g) ?? []).length;
    // The import and the one argument to pinReaderFromEnv.
    expect(calls).toBe(2);
  });
});
