import { join } from "node:path";
import {
  type ApprovalsClient,
  createApprovalsClient,
  createAuthenticatedClient,
} from "@ccc/service-api-client";
import { type DriverBrowser, type PollOptions, pollUntil, runPluginCommand } from "../driver.js";
import type { ServiceKind } from "../isolation-guards.js";
import { installResultRecorder, type RecorderOptions } from "../results.js";
import type { ServiceFixture } from "../service-fixture.js";
import { loadRunContext, type RunContext, serviceFixtureFor } from "../spec-context.js";
import {
  AUDIT_ROWS_SQL,
  copyStore,
  EFFECT_COUNT_SQL,
  EFFECTS_PER_PROPOSAL_SQL,
  EXPIRED_EVENTS_SQL,
  queryStore,
} from "../store-copy.js";
import { APPROVALS_COPY } from "./approvals-copy.js";

/**
 * Support for the approvals specs (05.2-06, E2E-04): pure checks that are unit-tested, the
 * renderer functions the specs run through `browser.execute`, and the service/client setup.
 *
 * Every renderer function (the ones that touch `document` or `window`) is SELF-CONTAINED: no
 * outer variables and no calls to another export, because wdio serialises the function body and
 * evaluates it in the Obsidian renderer. They return plain serialisable data and never return
 * DOM nodes. Recorded spike decisions are applied in the specs, not here.
 */

// ---------------------------------------------------------------------------
// Tolerances and waits: every number has a reason.

/** Fast enough to catch a status line that shows for about a second, light on the renderer. */
export const POLL_INTERVAL_MS = 200;
/** A snapshot arriving over the event stream after a service start can take several seconds. */
export const UI_TIMEOUT_MS = 30_000;

/** Poll options for a UI wait, named after what the wait is for. */
export function uiWait(describe: string, timeoutMs: number = UI_TIMEOUT_MS): PollOptions {
  return { timeoutMs, intervalMs: POLL_INTERVAL_MS, describe };
}

// ---------------------------------------------------------------------------
// Pure checks

/** One row of the audit query (06-UAT test 7), as the read-only store reader returns it. */
export interface AuditRowLike {
  readonly seq: number;
  readonly event: string;
  readonly decided_via: string | null;
  readonly detail: string | null;
}

/** Audit events that mean something was carried out; a denial must never leave one. */
const EFFECT_EVENTS: ReadonlySet<string> = new Set(["claimed", "executed", "reconciled-executed"]);

const present = (value: string | null): boolean => value !== null && value !== "";

/**
 * Checks the audit rows of a denial, newest first: the first two events are denied then
 * requested, decided_via is set on the denied row only, no row is an effect and the effect
 * count is zero. Returns the problems found; an empty list means the audit trail is right.
 */
export function checkDeniedAudit(rows: readonly AuditRowLike[], effectCount: number): string[] {
  const problems: string[] = [];
  const [first, second] = rows;
  if (first === undefined || second === undefined) {
    return ["fewer than two audit rows"];
  }
  if (first.event !== "denied") problems.push("the newest audit row is not a denial");
  if (second.event !== "requested") problems.push("the row before the denial is not the request");
  if (first.event === "denied" && !present(first.decided_via)) {
    problems.push("decided_via is missing on the denied row");
  }
  if (second.event === "requested" && present(second.decided_via)) {
    problems.push("decided_via is set on the requested row");
  }
  if (rows.some((row) => EFFECT_EVENTS.has(row.event))) {
    problems.push("an audit row records an effect");
  }
  if (effectCount !== 0) problems.push(`the effect count is ${effectCount}, not 0`);
  return problems;
}

/** True when `expected` occurs in `history` in that order; other entries may sit between. */
export function containsInOrder(history: readonly string[], expected: readonly string[]): boolean {
  let from = 0;
  for (const wanted of expected) {
    const at = history.indexOf(wanted, from);
    if (at < 0) return false;
    from = at + 1;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Renderer-side types and functions

interface DomEl {
  textContent: string | null;
  tagName: string;
  nextElementSibling: DomEl | null;
  childNodes: ArrayLike<{ nodeType: number; textContent: string | null }>;
  querySelector(selector: string): DomEl | null;
  querySelectorAll(selector: string): ArrayLike<DomEl>;
  getAttribute(name: string): string | null;
  matches(selector: string): boolean;
  click(): void;
  focus(): void;
}

interface DomDoc {
  activeElement: DomEl | null;
  body: DomEl;
  querySelector(selector: string): DomEl | null;
  querySelectorAll(selector: string): ArrayLike<DomEl>;
}

interface RendererWindow {
  __cccUatSpies?: Record<string, unknown>;
  MutationObserver?: new (
    callback: () => void,
  ) => { observe(target: unknown, options: unknown): void };
}

declare const document: DomDoc;
declare const window: RendererWindow;

export type FocusKind = "deny" | "approve" | "heading" | "other" | "none";

/** What the request pane and the status line show right now. */
export interface PaneSnapshot {
  /** A request pane is on screen. */
  present: boolean;
  /** The pane's data-state (pending, denied, executed ...), or null. */
  state: string | null;
  /** The pane heading text. */
  heading: string;
  /** Block text by data-block name (who, happen, target, change, reason, risks, state, record, history ...). */
  blocks: Record<string, string>;
  /** Definition-list fields by term (Requested by, Request ID, Content fingerprint ...). */
  fields: Record<string, string>;
  /** The History list, one label per entry with the time left off. */
  history: string[];
  /** The provenance captions ("Provided by ..." or "Computed by ..."). */
  captions: string[];
  /** The pending countdown phrase, or an empty string. */
  countdown: string;
  /** The state block's explanation text. */
  explanation: string;
  /** The polite status line text. */
  status: string;
  denyPresent: boolean;
  approvePresent: boolean;
  /** aria-disabled is "true" (the product never uses the native attribute). */
  denyDisabled: boolean;
  approveDisabled: boolean;
  /** The visible reasons under the decision controls. */
  decisionReasons: string[];
  /** Where keyboard focus is. */
  focus: FocusKind;
  /** The "listed under ..." sentence shown when the active chip is not the request's chip. */
  relocated: string;
}

/** Runs in the renderer: reads the open request pane and the status line. */
export function readPaneSnapshot(): PaneSnapshot {
  const status = document.querySelector(".ccc-approvals-status")?.textContent ?? "";
  const pane = document.querySelector(".ccc-approval-detail");
  const active = document.activeElement;
  let focus: FocusKind = "none";
  if (active !== null) {
    const decision = active.getAttribute("data-decision");
    if (decision === "deny") focus = "deny";
    else if (decision === "approve") focus = "approve";
    else if (active.matches("h4[data-block='heading']")) focus = "heading";
    else focus = "other";
  }
  if (pane === null) {
    return {
      present: false,
      state: null,
      heading: "",
      blocks: {},
      fields: {},
      history: [],
      captions: [],
      countdown: "",
      explanation: "",
      status,
      denyPresent: false,
      approvePresent: false,
      denyDisabled: false,
      approveDisabled: false,
      decisionReasons: [],
      focus,
      relocated: "",
    };
  }
  const blocks: Record<string, string> = {};
  for (const el of Array.from(pane.querySelectorAll("[data-block]"))) {
    const name = el.getAttribute("data-block");
    if (name !== null && name !== "") blocks[name] = el.textContent ?? "";
  }
  const fields: Record<string, string> = {};
  for (const term of Array.from(pane.querySelectorAll("dt"))) {
    const value = term.nextElementSibling;
    if (value !== null) fields[term.textContent ?? ""] = value.textContent ?? "";
  }
  const history = Array.from(pane.querySelectorAll(".ccc-approval-history li")).map(
    (li) => li.childNodes[0]?.textContent ?? "",
  );
  const deny = pane.querySelector("[data-decision='deny']");
  const approve = pane.querySelector("[data-decision='approve']");
  return {
    present: true,
    state: pane.getAttribute("data-state"),
    heading: pane.querySelector("h4")?.textContent ?? "",
    blocks,
    fields,
    history,
    captions: Array.from(pane.querySelectorAll("[data-caption]")).map((el) => el.textContent ?? ""),
    countdown: pane.querySelector(".ccc-approval-time")?.textContent ?? "",
    explanation: pane.querySelector(".ccc-approval-explanation")?.textContent ?? "",
    status,
    denyPresent: deny !== null,
    approvePresent: approve !== null,
    denyDisabled: deny?.getAttribute("aria-disabled") === "true",
    approveDisabled: approve?.getAttribute("aria-disabled") === "true",
    decisionReasons: Array.from(
      pane.querySelectorAll("[aria-label='Decision'] .ccc-list-meta"),
    ).map((el) => el.textContent ?? ""),
    focus,
    relocated: pane.querySelector(".ccc-approval-relocated")?.textContent ?? "",
  };
}

/** The filter chips as the section shows them. */
export interface ChipSnapshot {
  /** The chip row is one role=group labelled Approval filter. */
  groupPresent: boolean;
  chips: Array<{ text: string; name: string; pressed: boolean; focused: boolean }>;
}

/** Runs in the renderer: reads the filter chips. */
export function readChipSnapshot(): ChipSnapshot {
  const group = document.querySelector("[role='group'][aria-label='Approval filter']");
  const chips = Array.from(document.querySelectorAll(".ccc-filter-chip")).map((chip) => ({
    text: chip.textContent ?? "",
    name: chip.getAttribute("aria-label") ?? "",
    pressed: chip.getAttribute("aria-pressed") === "true",
    focused: document.activeElement === chip,
  }));
  return { groupPresent: group !== null, chips };
}

/** One row of the request list. */
export interface RowSnapshot {
  title: string;
  state: string;
  selected: boolean;
  meta: string;
}

/** Runs in the renderer: reads the request list. */
export function readRowSnapshot(): RowSnapshot[] {
  return Array.from(document.querySelectorAll(".ccc-approval-row")).map((row) => ({
    title: row.querySelector("button")?.getAttribute("title") ?? "",
    state: row.getAttribute("data-state") ?? "",
    selected: row.getAttribute("data-selected") === "true",
    meta: row.querySelector(".ccc-approval-row-meta")?.textContent ?? "",
  }));
}

/** Runs in the renderer: the Approvals section heading text, or null when it is not on screen. */
export function readApprovalsHeading(): string | null {
  const heading = document.querySelector(".ccc-approvals h3");
  return heading === null ? null : (heading.textContent ?? "").trim();
}

/** Runs in the renderer: presses a decision control `times` times back to back; returns the presses made. */
export function clickDecision(kind: "deny" | "approve", times: number): number {
  const button = document.querySelector(`[data-decision='${kind}']`);
  if (button === null) return 0;
  for (let press = 0; press < times; press += 1) button.click();
  return times;
}

/** Runs in the renderer: selects the request in row `index`; false when there is no such row. */
export function clickRow(index: number): boolean {
  const button = document.querySelectorAll(".ccc-approval-row-button")[index];
  if (button === undefined) return false;
  button.click();
  return true;
}

/** Runs in the renderer: presses the filter chip whose name starts with `label`. */
export function clickChip(label: string): boolean {
  for (const chip of Array.from(document.querySelectorAll(".ccc-filter-chip"))) {
    if ((chip.getAttribute("aria-label") ?? "").startsWith(label)) {
      chip.click();
      return true;
    }
  }
  return false;
}

/**
 * Runs in the renderer: starts recording every distinct text the polite status line shows, so a
 * short-lived state ("Approved. Carrying out the action...") that a poll could miss is still seen.
 * Returns false when a recorder is already installed.
 */
export function installStatusRecorder(): boolean {
  const w = window;
  const ns = w.__cccUatSpies ?? {};
  w.__cccUatSpies = ns;
  if (ns["statusHistory"] !== undefined) return false;
  const seen: string[] = [];
  ns["statusHistory"] = seen;
  const Observer = w.MutationObserver;
  if (Observer === undefined) return false;
  // No named inner functions: wdio serialises this body, and a name-keeping loader would inject a
  // helper call that does not exist in the renderer. The callback body is written out twice.
  new Observer(() => {
    const now = (document.querySelector(".ccc-approvals-status")?.textContent ?? "").trim();
    if (now !== "" && seen[seen.length - 1] !== now) seen.push(now);
  }).observe(document.body, { subtree: true, childList: true, characterData: true });
  const first = (document.querySelector(".ccc-approvals-status")?.textContent ?? "").trim();
  if (first !== "") seen.push(first);
  return true;
}

/** Runs in the renderer: the recorded status line texts, oldest first. */
export function readStatusHistory(): string[] {
  const seen = window.__cccUatSpies?.["statusHistory"] as string[] | undefined;
  return seen === undefined ? [] : [...seen];
}

/** Runs in the renderer: forgets the recorded status texts (the recorder keeps running). */
export function resetStatusHistory(): boolean {
  const seen = window.__cccUatSpies?.["statusHistory"] as string[] | undefined;
  if (seen === undefined) return false;
  seen.length = 0;
  return true;
}

// ---------------------------------------------------------------------------
// Spec-side helpers

/** The slice of the wdio browser these helpers use; the real browser satisfies it. */
export interface SupportBrowser extends DriverBrowser {
  execute<R, A extends unknown[]>(script: (...args: A) => R, ...args: A): Promise<R>;
}

/** Collapses whitespace in every string of a snapshot; the renderer functions return raw text. */
export function squashDeep<T>(value: T): T {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim() as T;
  if (Array.isArray(value)) return value.map((entry) => squashDeep(entry)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [squashDeep(key), squashDeep(entry)]),
    ) as T;
  }
  return value;
}

/** The request pane and status line, whitespace squashed. */
export async function readPane(browser: SupportBrowser): Promise<PaneSnapshot> {
  return squashDeep(await browser.execute(readPaneSnapshot));
}

/** The filter chips, whitespace squashed. */
export async function readChips(browser: SupportBrowser): Promise<ChipSnapshot> {
  return squashDeep(await browser.execute(readChipSnapshot));
}

/** The request list, whitespace squashed. */
export async function readRows(browser: SupportBrowser): Promise<RowSnapshot[]> {
  return squashDeep(await browser.execute(readRowSnapshot));
}

/**
 * Types the wdio global browser as the slice these helpers use. The real browser has the same
 * methods but richer, differently-shaped signatures (wdio element transforms, the typed
 * Obsidian context), which the structural interface cannot express; one cast lives here.
 */
export function supportBrowser(real: unknown): SupportBrowser {
  return real as SupportBrowser;
}

/**
 * Appends one result line per finished test to the run's results file (D-09). Pass mocha's
 * global afterEach; it is typed unknown because mocha's own overloads differ from the hook shape.
 */
export function installSpecResultRecorder(afterEachHook: unknown): void {
  installResultRecorder({
    afterEach: afterEachHook as RecorderOptions["afterEach"],
    resultsPath: loadRunContext().paths.resultsPath,
  });
}

const PLUGIN_ID = "claude-command-center";

export const INBOX_COMMAND_ID = `${PLUGIN_ID}:${APPROVALS_COPY.inboxCommandSuffix}`;
export const SETUP_COMMAND_ID = `${PLUGIN_ID}:${APPROVALS_COPY.setupCommandSuffix}`;

/** A started throwaway service, its clients and the way to stop it. */
export interface ApprovalsEnvironment {
  readonly context: RunContext;
  readonly fixture: ServiceFixture;
  readonly approvals: ApprovalsClient;
  /** Stops the service; safe to call when it is already stopped. */
  stop(): Promise<void>;
}

/**
 * Loads the run context, creates the service fixture, clears the store, starts the service of
 * `kind` and builds the authenticated approvals client for the sandbox socket. The expiry kind
 * is the only one that carries the test lifetime variables (D-05).
 */
export async function startApprovalsEnvironment(kind: ServiceKind): Promise<ApprovalsEnvironment> {
  const context = loadRunContext();
  const fixture = serviceFixtureFor(context);
  await fixture.resetData();
  await fixture.start({ kind });
  const approvals = createApprovalsClient(
    createAuthenticatedClient({ socketPath: context.socketPath }),
  );
  return { context, fixture, approvals, stop: () => fixture.stop() };
}

/** Posts a test approval through the service API and returns its id; "already pending" is an error. */
export async function sendTestApproval(approvals: ApprovalsClient): Promise<string> {
  const response = await approvals.test();
  if (response.outcome !== "proposed") {
    throw new Error("The test approval was not proposed: a request is already pending.");
  }
  return response.proposalId;
}

/**
 * Denies every request that is still pending, so the next test approval is a new request (a test
 * approval while another is pending is reported as already pending). A request that vanishes
 * meanwhile is ignored.
 */
export async function clearPending(approvals: ApprovalsClient): Promise<void> {
  const snapshot = await approvals.list();
  for (const summary of snapshot.pending) {
    try {
      const detail = await approvals.get(summary.proposalId);
      await approvals.decide({
        proposalId: summary.proposalId,
        decision: "deny",
        payloadHash: detail.payloadHash,
      });
    } catch {
      // Already decided or expired by the time we got to it.
    }
  }
}

/** Runs the open-approval-inbox command and waits for the Approvals heading. */
export async function openApprovalInbox(browser: SupportBrowser): Promise<void> {
  await runPluginCommand(browser, INBOX_COMMAND_ID);
  await pollUntil(
    async () => (await browser.execute(readApprovalsHeading)) === APPROVALS_COPY.sectionHeading,
    uiWait("the Approvals section heading"),
  );
}

/** Waits until the pane (and status line) satisfy `accept`, and returns that snapshot. */
export async function waitForPane(
  browser: SupportBrowser,
  accept: (pane: PaneSnapshot) => boolean,
  describe: string,
  timeoutMs: number = UI_TIMEOUT_MS,
): Promise<PaneSnapshot> {
  return pollUntil(
    async () => {
      const pane = await readPane(browser);
      return accept(pane) ? pane : null;
    },
    uiWait(describe, timeoutMs),
  );
}

/**
 * With exactly one pending request, opens the inbox, selects that request's row and waits for
 * the full pane (decision controls present). Returns the pane.
 */
export async function selectOnlyPendingRequest(browser: SupportBrowser): Promise<PaneSnapshot> {
  await openApprovalInbox(browser);
  await pollUntil(async () => {
    const rows = await readRows(browser);
    return rows.length === 1 && rows[0]?.state === "pending";
  }, uiWait("one pending request in the list"));
  if (!(await browser.execute(clickRow, 0))) throw new Error("The pending request row is missing.");
  return waitForPane(
    browser,
    (pane) => pane.present && pane.state === "pending" && pane.denyPresent && !pane.denyDisabled,
    "the pending request pane with Deny enabled",
  );
}

/** What the read-only store copy holds that the approvals specs assert on. */
export interface StoreReading {
  /** The newest audit rows, newest first. */
  rows: AuditRowLike[];
  effectCount: number;
  effectsPerProposal: Array<{ proposalId: string; effects: number }>;
  expired: Array<{ seq: number; proposalId: string; event: string }>;
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number => (typeof value === "number" ? value : Number(value));

/** Copies the store and runs the fixed audit and effect queries against the copy (read-only). */
export async function readStore(context: RunContext): Promise<StoreReading> {
  const { copyPath } = copyStore({
    runtimeDir: context.paths.runtimeDir,
    destDir: join(context.paths.tmpDir, "store-reads"),
  });
  const rows = await queryStore({ copyPath, sql: AUDIT_ROWS_SQL });
  const effects = await queryStore({ copyPath, sql: EFFECT_COUNT_SQL });
  const perProposal = await queryStore({ copyPath, sql: EFFECTS_PER_PROPOSAL_SQL });
  const expired = await queryStore({ copyPath, sql: EXPIRED_EVENTS_SQL });
  return {
    rows: rows.map((row) => ({
      seq: num(row["seq"]),
      event: text(row["event"]) ?? "",
      decided_via: text(row["decided_via"]),
      detail: text(row["detail"]),
    })),
    effectCount: num(effects[0]?.["effects"] ?? 0),
    effectsPerProposal: perProposal.map((row) => ({
      proposalId: text(row["proposal_id"]) ?? "",
      effects: num(row["effects"]),
    })),
    expired: expired.map((row) => ({
      seq: num(row["seq"]),
      proposalId: text(row["proposal_id"]) ?? "",
      event: text(row["event"]) ?? "",
    })),
  };
}
