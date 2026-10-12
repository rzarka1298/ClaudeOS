import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type ApprovalsClient,
  createApprovalsClient,
  createAuthenticatedClient,
} from "@ccc/service-api-client";
import { type DriverBrowser, type PollOptions, pollUntil, runPluginCommand } from "../driver.js";
import type { ServiceKind } from "../isolation-guards.js";
import { readNotifications } from "../renderer-spies.js";
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

/** One recorded view activation (workspace active-leaf-change), by view type. */
export interface ActivationEntry {
  readonly viewType: string;
}

/**
 * True when a banner click caused exactly one navigation: one activation of the command-center
 * view among the recorded ones (other views are ignored) and one command-center leaf. A
 * duplicate handler would show as a second activation or a second leaf.
 */
export function isExactlyOneNavigation(
  entries: readonly ActivationEntry[],
  viewType: string,
  leafCount: number,
): boolean {
  return leafCount === 1 && entries.filter((entry) => entry.viewType === viewType).length === 1;
}

/** One step of a keyboard walk over the filter chips: the key, the focused and the pressed chip names. */
export interface ChipStep {
  readonly key: string;
  readonly focused: string | null;
  readonly pressed: string | null;
}

/** The accessible name of a chip announces its label and count: `Pending, 2 requests`. */
const CHIP_NAME = /^(Pending|Decided|Expired), \d+ requests?$/;

/**
 * Checks a chip-keyboard transcript against the expected walk: same length and keys, the focused
 * and pressed chips start with the expected labels, and every focused chip announces its count
 * in its name. Returns the problems found.
 */
export function checkChipTranscript(
  transcript: readonly ChipStep[],
  expected: ReadonlyArray<{ key: string; focused: string; pressed: string }>,
): string[] {
  if (transcript.length !== expected.length) {
    return [`the walk has ${transcript.length} steps, expected ${expected.length}`];
  }
  const problems: string[] = [];
  expected.forEach((want, index) => {
    const step = transcript[index] as ChipStep;
    if (step.key !== want.key)
      problems.push(`step ${index + 1}: key ${step.key}, expected ${want.key}`);
    if (step.focused === null || !step.focused.startsWith(want.focused)) {
      problems.push(`step ${index + 1}: focus is not on the ${want.focused} chip`);
    } else if (!CHIP_NAME.test(step.focused)) {
      problems.push(`step ${index + 1}: the focused chip name does not announce its count`);
    }
    if (step.pressed === null || !step.pressed.startsWith(want.pressed)) {
      problems.push(`step ${index + 1}: the pressed chip is not ${want.pressed}`);
    }
  });
  return problems;
}

/** A note in the vault's system folder, read with Node file APIs. */
export interface MirrorFile {
  readonly name: string;
  readonly mtimeMs: number;
  readonly content: string;
}

/**
 * The name of the newest note whose text links `obsidian://ccc-approval?id=<proposalId>`; an id
 * that merely starts with the given one does not match. Null when no note links it.
 */
export function findNewestMirrorNote(
  files: readonly MirrorFile[],
  proposalId: string,
): string | null {
  const needle = `${APPROVALS_COPY.mirrorLinkPrefix}${proposalId}`;
  let best: MirrorFile | null = null;
  for (const file of files) {
    let from = 0;
    let found = false;
    for (;;) {
      const at = file.content.indexOf(needle, from);
      if (at < 0) break;
      const next = file.content[at + needle.length] ?? "";
      if (!/[A-Za-z0-9]/.test(next)) {
        found = true;
        break;
      }
      from = at + 1;
    }
    if (found && (best === null || file.mtimeMs > best.mtimeMs)) best = file;
  }
  return best === null ? null : best.name;
}

/** The first index at or after `fromIndex` whose title is `title`, or -1. */
export function findNewNotification(
  records: ReadonlyArray<{ title: string }>,
  fromIndex: number,
  title: string,
): number {
  for (let index = Math.max(0, fromIndex); index < records.length; index += 1) {
    if (records[index]?.title === title) return index;
  }
  return -1;
}

/** Reads the Agent runs count chip's visible text: `3`, or `9+` when capped; null otherwise. */
export function parseCountChip(text: string): { count: number; capped: boolean } | null {
  const match = /^(\d+)(\+?)$/.exec(text.trim());
  if (match?.[1] === undefined) return null;
  return { count: Number(match[1]), capped: match[2] === "+" };
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

interface LeafLite {
  detach(): void;
  view?: { getViewType?: () => string };
}

interface AppLite {
  workspace: {
    on(name: string, callback: (leaf: LeafLite | null) => void): unknown;
    getLeavesOfType(viewType: string): unknown[];
    getLeaf(kind: string): LeafLite;
    setActiveLeaf(leaf: LeafLite, params?: { focus?: boolean }): void;
  };
}

interface RendererWindow {
  app?: AppLite;
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
  /** The requester-supplied reason text. */
  reason: string;
  /** The risk list items (empty when the block reads "None listed."). */
  risks: string[];
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
      reason: "",
      risks: [],
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
    reason: pane.querySelector(".ccc-approval-reason")?.textContent ?? "",
    risks: Array.from(pane.querySelectorAll(".ccc-approval-risks li")).map(
      (el) => el.textContent ?? "",
    ),
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

/** The Agent runs tab's pending-approval chip. */
export interface NavChipSnapshot {
  present: boolean;
  /** The visible number (`3`, or `9+`), empty when the chip is absent. */
  visible: string;
  /** The visually hidden sentence that carries the true count into the tab's name. */
  spoken: string;
}

/** Runs in the renderer: reads the Agent runs tab and its count chip (the tab strip is always on screen). */
export function readNavChip(): NavChipSnapshot {
  const tab = document.querySelector("#ccc-tab-agent-runs");
  if (tab === null) return { present: false, visible: "", spoken: "" };
  return {
    present: true,
    visible: tab.querySelector(".ccc-nav-count")?.textContent ?? "",
    spoken: tab.querySelector(".ccc-visually-hidden")?.textContent ?? "",
  };
}

/** Runs in the renderer: the active destination's heading (the panel's h2), or an empty string. */
export function readDestinationHeading(): string {
  return document.querySelector(".ccc-content h2")?.textContent ?? "";
}

/** Runs in the renderer: puts keyboard focus on the Approvals heading; false when it is not on screen. */
export function focusApprovalsHeading(): boolean {
  const heading = document.querySelector(".ccc-approvals h3");
  if (heading === null) return false;
  heading.focus();
  return true;
}

/** Runs in the renderer: presses the modal button with exactly this text; false when there is none. */
export function clickModalButton(label: string): boolean {
  for (const button of Array.from(document.querySelectorAll(".modal button"))) {
    if ((button.textContent ?? "").trim() === label) {
      button.click();
      return true;
    }
  }
  return false;
}

/**
 * Runs in the renderer: records every distinct Obsidian Notice text that appears (the Notice
 * constructor lives inside Obsidian, so the page is watched instead). Returns false when a
 * recorder is already installed.
 */
export function installNoticeRecorder(): boolean {
  const w = window;
  const ns = w.__cccUatSpies ?? {};
  w.__cccUatSpies = ns;
  if (ns["notices"] !== undefined) return false;
  const seen: string[] = [];
  ns["notices"] = seen;
  const Observer = w.MutationObserver;
  if (Observer === undefined) return false;
  new Observer(() => {
    for (const notice of Array.from(document.querySelectorAll(".notice"))) {
      const now = (notice.textContent ?? "").trim();
      if (now !== "" && !seen.includes(now)) seen.push(now);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true });
  return true;
}

/** Runs in the renderer: the Notice texts seen since the last clear, oldest first. */
export function readNotices(): string[] {
  const seen = window.__cccUatSpies?.["notices"] as string[] | undefined;
  return seen === undefined ? [] : [...seen];
}

/** Runs in the renderer: forgets the recorded Notice texts (the recorder keeps running). */
export function clearNotices(): boolean {
  const seen = window.__cccUatSpies?.["notices"] as string[] | undefined;
  if (seen === undefined) return false;
  seen.length = 0;
  return true;
}

/** Runs in the renderer: records every workspace active-leaf-change by view type. */
export function installActivationRecorder(): boolean {
  const w = window;
  const ns = w.__cccUatSpies ?? {};
  w.__cccUatSpies = ns;
  if (ns["activations"] !== undefined) return false;
  const seen: Array<{ viewType: string }> = [];
  ns["activations"] = seen;
  if (w.app === undefined) return false;
  w.app.workspace.on("active-leaf-change", (leaf) => {
    seen.push({ viewType: leaf?.view?.getViewType?.() ?? "" });
  });
  return true;
}

/** Runs in the renderer: the recorded activations since the last reset. */
export function readActivations(): Array<{ viewType: string }> {
  const seen = window.__cccUatSpies?.["activations"] as Array<{ viewType: string }> | undefined;
  return seen === undefined ? [] : seen.map((entry) => ({ ...entry }));
}

/** Runs in the renderer: forgets the recorded activations (the recorder keeps running). */
export function resetActivations(): boolean {
  const seen = window.__cccUatSpies?.["activations"] as unknown[] | undefined;
  if (seen === undefined) return false;
  seen.length = 0;
  return true;
}

/**
 * Runs in the renderer: opens a new empty tab and makes it the active leaf, so the next jump to
 * the command center is a real activation rather than a no-op on an already active leaf.
 */
export function activateScratchLeaf(): boolean {
  const w = window;
  if (w.app === undefined) return false;
  const leaf = w.app.workspace.getLeaf("tab");
  w.app.workspace.setActiveLeaf(leaf, { focus: true });
  const ns = w.__cccUatSpies ?? {};
  w.__cccUatSpies = ns;
  ns["scratchLeaf"] = leaf;
  return true;
}

/** Runs in the renderer: closes the empty tab opened by activateScratchLeaf. */
export function detachScratchLeaf(): boolean {
  const ns = window.__cccUatSpies;
  const leaf = ns?.["scratchLeaf"] as LeafLite | undefined;
  if (ns === undefined || leaf === undefined) return false;
  leaf.detach();
  ns["scratchLeaf"] = undefined;
  return true;
}

/** Runs in the renderer: how many open leaves hold this view type. */
export function countLeavesOfType(viewType: string): number {
  return window.app?.workspace.getLeavesOfType(viewType).length ?? 0;
}

// ---------------------------------------------------------------------------
// Spec-side helpers

/** The slice of the wdio browser these helpers use; the real browser satisfies it. */
export interface SupportBrowser extends DriverBrowser {
  execute<R, A extends unknown[]>(script: (...args: A) => R, ...args: A): Promise<R>;
  keys(value: string | string[]): Promise<void>;
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

/** The Agent runs count chip, whitespace squashed. */
export async function readNav(browser: SupportBrowser): Promise<NavChipSnapshot> {
  return squashDeep(await browser.execute(readNavChip));
}

/** Runs the Open overview command, so the Approvals section is off screen, and waits for the Overview heading. */
export async function openOverview(browser: SupportBrowser): Promise<void> {
  await runPluginCommand(browser, `${PLUGIN_ID}:${APPROVALS_COPY.overviewCommandSuffix}`);
  await pollUntil(
    async () =>
      (await browser.execute(readDestinationHeading)).trim() === APPROVALS_COPY.overviewLabel,
    uiWait("the Overview destination"),
  );
}

/**
 * Runs Set up managed vault in the vault copy: starts the command, presses Confirm in the plan
 * modal and waits for the "Managed vault ready" Notice. Safe to repeat (existing paths are kept).
 */
export async function ensureManagedVault(browser: SupportBrowser): Promise<void> {
  await browser.execute(installNoticeRecorder);
  await browser.execute(clearNotices);
  await runPluginCommand(browser, SETUP_COMMAND_ID);
  await pollUntil(
    () => browser.execute(clickModalButton, APPROVALS_COPY.confirmButton),
    uiWait("the vault setup confirmation"),
  );
  await pollUntil(
    async () =>
      (await browser.execute(readNotices)).some((notice) =>
        notice.startsWith(APPROVALS_COPY.vaultReadyPrefix),
      ),
    uiWait("the managed vault ready notice"),
  );
}

/**
 * Waits for a recorded notification titled `title` at or after `fromIndex` in the spy's list and
 * returns its index (wrapped, because index 0 is a legitimate answer a poll would treat as falsy).
 */
export async function waitForNotification(
  browser: SupportBrowser,
  fromIndex: number,
  title: string = APPROVALS_COPY.notificationTitle,
): Promise<{ index: number }> {
  return pollUntil(
    async () => {
      const { records } = await browser.execute(readNotifications);
      const index = findNewNotification(records, fromIndex, title);
      return index >= 0 ? { index } : null;
    },
    uiWait(`a "${title}" notification`),
  );
}

/** How many notifications the spy has recorded so far. */
export async function notificationCount(browser: SupportBrowser): Promise<number> {
  return (await browser.execute(readNotifications)).records.length;
}

/** The keys of the chip walk and the labels they are reported under. */
export type ChipKey = "Tab" | "Shift+Tab" | "Enter";

/**
 * Walks the filter chips with the keyboard from the Approvals heading: sends each key, then
 * records which chip has focus (its accessible name) and which is pressed.
 */
export async function walkChips(
  browser: SupportBrowser,
  keys: readonly ChipKey[],
): Promise<ChipStep[]> {
  if (!(await browser.execute(focusApprovalsHeading))) {
    throw new Error("The Approvals heading is not on screen, so the chip walk cannot start.");
  }
  const steps: ChipStep[] = [];
  for (const key of keys) {
    await browser.keys(key === "Shift+Tab" ? ["Shift", "Tab"] : key);
    const { chips } = await readChips(browser);
    steps.push({
      key,
      focused: chips.find((chip) => chip.focused)?.name ?? null,
      pressed: chips.find((chip) => chip.pressed)?.name ?? null,
    });
  }
  return steps;
}

/** Reads the notes in the vault copy's system folder (Node file APIs; never written). */
export function readMirrorFiles(vaultPath: string): MirrorFile[] {
  const dir = join(vaultPath, "system");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => {
      const path = join(dir, name);
      return { name, mtimeMs: statSync(path).mtimeMs, content: readFileSync(path, "utf8") };
    });
}
