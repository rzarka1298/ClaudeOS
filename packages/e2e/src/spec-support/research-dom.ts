/**
 * The renderer side of the research specs (plan 07-17): functions wdio serialises with
 * `toString()` and evaluates inside Obsidian (`browser.execute`), reading the Research
 * destination's DOM into plain data. Nothing here clicks, types or changes the page except the
 * transcript observer, the clipboard and scroll spies and the layout probes, which are named as such.
 *
 * Every exported `renderer*` function is SELF-CONTAINED (no imports, no outer variables, no call
 * to another export). wdio's tsx loader compiles with keepNames, so a nested named function or a
 * const-bound arrow would become a `__name(...)` call the page does not have; shared helpers are
 * therefore arrow functions held in an array literal (an array element is not a naming context),
 * and callbacks are inline arguments. renderer-keepnames.test.ts compiles each one the way tsx does
 * and checks the text for `__name`. The class names arrive as an argument (the mirrored table), so
 * a function holds no literal of the plugin's.
 */

interface RRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

interface RStyle {
  display: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  maxWidth: string;
  marginTop: string;
  marginBottom: string;
  rowGap: string;
  gap: string;
  overflow: string;
  textOverflow: string;
  whiteSpace: string;
  transitionDuration: string;
  animationDuration: string;
  animationName: string;
  scrollBehavior: string;
  opacity: string;
  outlineStyle: string;
  outlineWidth: string;
  boxShadow: string;
  getPropertyValue(name: string): string;
}

interface RNode {
  textContent: string | null;
  tagName: string;
  id: string;
  className: string;
  parentElement: RNode | null;
  nextElementSibling: RNode | null;
  hidden: boolean;
  offsetParent: unknown;
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  style: { width: string; position: string; visibility: string; height: string };
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  matches(selector: string): boolean;
  closest(selector: string): RNode | null;
  querySelector(selector: string): RNode | null;
  querySelectorAll(selector: string): ArrayLike<RNode>;
  cloneNode(deep: boolean): RNode;
  appendChild(child: RNode): RNode;
  remove(): void;
  click(): void;
  focus(): void;
  getBoundingClientRect(): RRect;
}

interface RDocument {
  activeElement: RNode | null;
  body: RNode;
  documentElement: RNode;
  querySelector(selector: string): RNode | null;
  querySelectorAll(selector: string): ArrayLike<RNode>;
  createElement(tag: string): RNode;
}

declare const document: RDocument;
declare const window: {
  __cccResearch?: {
    records?: TranscriptRecord[];
    observer?: { disconnect(): void } | null;
    clipboard?: string[];
    scrolls?: Array<{ behavior: string | null }>;
    originals?: Record<string, unknown>;
    reducedMotion?: boolean;
  };
  MutationObserver: new (
    callback: () => void,
  ) => { observe(node: RNode, options: object): void; disconnect(): void };
  navigator: { clipboard: { writeText(text: string): Promise<void> } };
  Element: { prototype: { scrollIntoView(options?: unknown): void } };
  innerWidth: number;
  performance: { now(): number };
  setTimeout(callback: () => void, ms: number): unknown;
};
declare function getComputedStyle(node: RNode): RStyle;

/** The class names the readers use, passed in from the mirrored table. */
export interface ResearchDomConfig {
  readonly root: string;
  readonly runBox: string;
  readonly reason: string;
  readonly strip: string;
  readonly statusLine: string;
  readonly runStatus: string;
  readonly setupCallout: string;
  readonly sourcesConfig: string;
  readonly layout: string;
  readonly listCell: string;
  readonly readerCell: string;
  readonly listRegion: string;
  readonly listEmpty: string;
  readonly listError: string;
  readonly emptyHeading: string;
  readonly row: string;
  readonly rowButton: string;
  readonly rowMeta: string;
  readonly listMore: string;
  readonly badge: string;
  readonly badgeGlyph: string;
  readonly badgeLabel: string;
  readonly hidden: string;
  readonly reader: string;
  readonly readerMeta: string;
  readonly readerCounts: string;
  readonly readerAi: string;
  readonly readerStale: string;
  readonly readerActions: string;
  readonly readerUnavailable: string;
  readonly readerLegend: string;
  readonly readerItems: string;
  readonly readerRun: string;
  readonly item: string;
  readonly itemKind: string;
  readonly itemText: string;
  readonly quoteCaption: string;
  readonly quote: string;
  readonly citations: string;
  readonly source: string;
  readonly sourcesList: string;
  readonly detailFields: string;
  readonly callout: string;
  readonly calloutHeading: string;
}

export interface RenderedBadge {
  kind: string;
  glyph: string;
  label: string;
}

export interface RenderedRow {
  title: string;
  /** The visible text of the meta line (time, badges, counts). */
  meta: string;
  dateTime: string | null;
  badges: RenderedBadge[];
  selected: boolean;
  unreadable: boolean;
}

export interface RenderedFinding {
  kind: string;
  /** The visible kind tag: glyph and word. */
  tag: string;
  tagWord: string;
  hiddenPrefix: string;
  text: string;
  quote: string | null;
  quoteCaption: string | null;
  unverified: boolean;
  citations: Array<{ name: string; text: string; cite: string }>;
}

export interface RenderedField {
  term: string;
  /** The value's visible text without its buttons. */
  text: string;
  buttons: string[];
  titles: string[];
}

export interface RenderedSource {
  number: number;
  title: string;
  fields: RenderedField[];
  backTo: string | null;
}

export interface RenderedReader {
  loading: boolean;
  /** The heading of a reader that did not open; null for an opened report. */
  failureHeading: string | null;
  title: string;
  hasBackButton: boolean;
  meta: string;
  metaBadges: RenderedBadge[];
  counts: string;
  ai: string;
  hasOpenNote: boolean;
  stale: string | null;
  unavailable: { heading: string; intro: string; entries: string[] } | null;
  legend: Array<{ kind: string; term: string; meaning: string }>;
  findings: RenderedFinding[];
  sources: RenderedSource[];
  run: RenderedField[];
  runBadges: RenderedBadge[];
  hasOpenRunNote: boolean;
  /** The section headings in document order (unavailable sources come before the findings). */
  headings: string[];
  /** Links, images, frames, scripts and embeds inside the reader: none may come from source text. */
  activeElements: number;
}

export interface RenderedResearch {
  mounted: boolean;
  heading: string;
  dimmed: boolean;
  busy: boolean;
  runNow: {
    present: boolean;
    label: string;
    name: string;
    disabled: boolean;
    busy: boolean;
    reason: string | null;
  };
  subline: string;
  strip: { text: string; badges: RenderedBadge[] };
  status: string;
  runStatus: {
    heading: string;
    rows: Array<{ label: string; value: string; badges: RenderedBadge[]; buttons: string[] }>;
    setup: { heading: string; body: string } | null;
    sourcesToggle: string | null;
    sourcesExpanded: boolean | null;
  };
  list: {
    busy: boolean;
    dimmed: boolean;
    rows: RenderedRow[];
    emptyHeading: string | null;
    emptyBody: string | null;
    showMore: string | null;
    errorText: string | null;
  };
  layout: { readerOpen: string | null; mode: string | null };
  reader: RenderedReader | null;
}

/** One change of the status line or the Current run row, in order. */
export interface TranscriptRecord {
  at: number;
  status: string;
  current: string | null;
}

/**
 * Reads the whole Research destination into plain data. The visible text of a node is its text
 * with the screen-reader-only spans left out, whitespace collapsed.
 */
export function rendererReadResearch(c: ResearchDomConfig): RenderedResearch {
  const H = [
    (n: RNode | null): string => {
      if (n === null) return "";
      const copy = n.cloneNode(true);
      const hiddenNodes = copy.querySelectorAll(`.${c.hidden}`);
      for (let i = 0; i < hiddenNodes.length; i += 1) (hiddenNodes[i] as RNode).remove();
      return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
    },
    (n: RNode | null): RenderedBadge[] => {
      const out: RenderedBadge[] = [];
      if (n === null) return out;
      const found = n.querySelectorAll(`.${c.badge}`);
      for (let i = 0; i < found.length; i += 1) {
        const badge = found[i] as RNode;
        out.push({
          kind: badge.getAttribute("data-badge") ?? "",
          glyph: (badge.querySelector(`.${c.badgeGlyph}`)?.textContent ?? "").trim(),
          label: (badge.querySelector(`.${c.badgeLabel}`)?.textContent ?? "").trim(),
        });
      }
      return out;
    },
    (n: RNode | null): string => {
      if (n === null) return "";
      const copy = n.cloneNode(true);
      const drop = copy.querySelectorAll(`.${c.hidden}, button`);
      for (let i = 0; i < drop.length; i += 1) (drop[i] as RNode).remove();
      return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
    },
    (n: RNode | null): { buttons: string[]; titles: string[] } => {
      const buttons: string[] = [];
      const titles: string[] = [];
      if (n === null) return { buttons, titles };
      const inside = n.querySelectorAll("button");
      for (let i = 0; i < inside.length; i += 1) {
        buttons.push(((inside[i] as RNode).textContent ?? "").trim());
      }
      const titled = n.querySelectorAll("[title]");
      for (let i = 0; i < titled.length; i += 1) {
        titles.push((titled[i] as RNode).getAttribute("title") ?? "");
      }
      return { buttons, titles };
    },
    (list: RNode | null): RenderedField[] => {
      const out: RenderedField[] = [];
      if (list === null) return out;
      const terms = list.querySelectorAll("dt");
      for (let i = 0; i < terms.length; i += 1) {
        const term = terms[i] as RNode;
        const value = term.nextElementSibling;
        const extras = (H[3] as (n: RNode | null) => { buttons: string[]; titles: string[] })(
          value,
        );
        out.push({
          term: (H[0] as (n: RNode | null) => string)(term),
          text: (H[2] as (n: RNode | null) => string)(value),
          buttons: extras.buttons,
          titles: extras.titles,
        });
      }
      return out;
    },
  ];
  const text = H[0] as (n: RNode | null) => string;
  const badgesOf = H[1] as (n: RNode | null) => RenderedBadge[];
  const plainOf = H[2] as (n: RNode | null) => string;
  const fieldsOf = H[4] as (list: RNode | null) => RenderedField[];

  const empty: RenderedResearch = {
    mounted: false,
    heading: "",
    dimmed: false,
    busy: false,
    runNow: { present: false, label: "", name: "", disabled: false, busy: false, reason: null },
    subline: "",
    strip: { text: "", badges: [] },
    status: "",
    runStatus: { heading: "", rows: [], setup: null, sourcesToggle: null, sourcesExpanded: null },
    list: {
      busy: false,
      dimmed: false,
      rows: [],
      emptyHeading: null,
      emptyBody: null,
      showMore: null,
      errorText: null,
    },
    layout: { readerOpen: null, mode: null },
    reader: null,
  };
  const root = document.querySelector(`section.${c.root}`);
  if (root === null) return empty;

  // Header: the heading, Run now and its reason.
  const runBox = root.querySelector(`.${c.runBox}`);
  const button = runBox?.querySelector("button") ?? null;
  const reasonNode = runBox?.querySelector(`.${c.reason}`) ?? null;

  // Run status rows: each term with the value that follows it.
  const rows: RenderedResearch["runStatus"]["rows"] = [];
  const statusSection = root.querySelector(`section.${c.runStatus}`);
  const statusTerms = statusSection?.querySelectorAll("dl > dt") ?? [];
  for (let i = 0; i < statusTerms.length; i += 1) {
    const term = statusTerms[i] as RNode;
    const value = term.nextElementSibling;
    rows.push({
      label: text(term),
      value: plainOf(value),
      badges: badgesOf(value),
      buttons: (H[3] as (n: RNode | null) => { buttons: string[] })(value).buttons,
    });
  }
  const callout = root.querySelector(`.${c.setupCallout}`);
  const toggle = root.querySelector(`.${c.sourcesConfig} > button`);

  // The report list.
  const region = root.querySelector(`.${c.listRegion}`);
  const listRows: RenderedRow[] = [];
  const rowNodes = region?.querySelectorAll(`li.${c.row}`) ?? [];
  for (let i = 0; i < rowNodes.length; i += 1) {
    const node = rowNodes[i] as RNode;
    const unreadable = node.getAttribute("data-unreadable") === "true";
    const rowButton = node.querySelector(`button.${c.rowButton}`);
    const meta = node.querySelector(`.${c.rowMeta}`);
    listRows.push({
      title: unreadable
        ? text(node.querySelector("p"))
        : ((node.querySelector(".ccc-clamp-2") as RNode | null)?.getAttribute("title") ??
          text(node.querySelector(".ccc-clamp-2"))),
      meta: text(meta),
      dateTime: node.querySelector("time")?.getAttribute("datetime") ?? null,
      badges: badgesOf(meta),
      selected: rowButton?.getAttribute("aria-current") === "true",
      unreadable,
    });
  }
  const emptyBox = region?.querySelector(`.${c.listEmpty}`) ?? null;
  const more = region?.querySelector(`button.${c.listMore}`) ?? null;
  const listError = region?.querySelector(`.${c.listError}`) ?? null;

  // The layout and the reader.
  const layoutNode = root.querySelector(`.${c.layout}`);
  const article = root.querySelector(`article.${c.reader}`);
  let reader: RenderedReader | null = null;
  if (article !== null) {
    const header = article.querySelector("header");
    const titleNode = (header ?? article).querySelector("h3");
    const unavailableNode = article.querySelector(`section.${c.readerUnavailable}`);
    const legendNode = article.querySelector(`dl.${c.readerLegend}`);
    const legend: RenderedReader["legend"] = [];
    const legendTerms = legendNode?.querySelectorAll("dt") ?? [];
    for (let i = 0; i < legendTerms.length; i += 1) {
      const term = legendTerms[i] as RNode;
      legend.push({
        kind: term.getAttribute("data-kind") ?? "",
        term: text(term),
        meaning: text(term.nextElementSibling),
      });
    }
    const findings: RenderedFinding[] = [];
    const itemNodes = article.querySelectorAll(`ol.${c.readerItems} > li.${c.item}`);
    for (let i = 0; i < itemNodes.length; i += 1) {
      const node = itemNodes[i] as RNode;
      const kindNode = node.querySelector(`.${c.itemKind}`);
      const spans = kindNode?.querySelectorAll("span") ?? [];
      const quoteNode = node.querySelector(`blockquote.${c.quote}`);
      const cites: RenderedFinding["citations"] = [];
      const citeButtons = node.querySelectorAll(`.${c.citations} button`);
      for (let b = 0; b < citeButtons.length; b += 1) {
        const cite = citeButtons[b] as RNode;
        cites.push({
          name: cite.getAttribute("aria-label") ?? "",
          text: text(cite),
          cite: cite.getAttribute("data-cite") ?? "",
        });
      }
      findings.push({
        kind: node.getAttribute("data-kind") ?? "",
        tag: text(kindNode),
        tagWord: spans.length > 1 ? text(spans[1] as RNode) : "",
        hiddenPrefix: (node.querySelector(`.${c.hidden}`)?.textContent ?? "").trim(),
        text: text(node.querySelector(`.${c.itemText}`)),
        quote: quoteNode === null ? null : text(quoteNode),
        quoteCaption:
          node.querySelector(`.${c.quoteCaption}`) === null
            ? null
            : text(node.querySelector(`.${c.quoteCaption}`)),
        unverified: node.getAttribute("data-quote-unverified") === "true",
        citations: cites,
      });
    }
    const sources: RenderedSource[] = [];
    const sourceNodes = article.querySelectorAll(`ol.${c.sourcesList} > li.${c.source}`);
    for (let i = 0; i < sourceNodes.length; i += 1) {
      const node = sourceNodes[i] as RNode;
      const back = node.querySelector("button[data-back-to-finding]");
      sources.push({
        number: Number(node.getAttribute("data-source")),
        title: text(node.querySelector("h5")).replace(/^\d+\.\s*/, ""),
        fields: fieldsOf(node.querySelector(`dl.${c.detailFields}`)),
        backTo: back === null ? null : text(back),
      });
    }
    const headings: string[] = [];
    const headingNodes = article.querySelectorAll("h4");
    for (let i = 0; i < headingNodes.length; i += 1) headings.push(text(headingNodes[i] as RNode));
    const runNode = article.querySelector(`section.${c.readerRun}`);
    const staleNode = article.querySelector(`.${c.readerStale}`);
    reader = {
      loading: article.getAttribute("aria-busy") === "true",
      failureHeading: header === null && titleNode !== null ? text(titleNode) : null,
      title: text(titleNode),
      hasBackButton: article.querySelector(":scope > button") !== null,
      meta: text(article.querySelector(`.${c.readerMeta}`)),
      metaBadges: badgesOf(article.querySelector(`.${c.readerMeta}`)),
      counts: text(article.querySelector(`.${c.readerCounts}`)),
      ai: text(article.querySelector(`.${c.readerAi}`)),
      hasOpenNote: article.querySelector(`.${c.readerActions} button`) !== null,
      stale: staleNode === null ? null : text(staleNode),
      unavailable:
        unavailableNode === null
          ? null
          : {
              heading: text(unavailableNode.querySelector("h4")),
              intro: text(unavailableNode.querySelector("p")),
              entries: (() => {
                const entries: string[] = [];
                const listItems = unavailableNode.querySelectorAll("li");
                for (let i = 0; i < listItems.length; i += 1)
                  entries.push(text(listItems[i] as RNode));
                return entries;
              })(),
            },
      legend,
      findings,
      sources,
      run: fieldsOf(runNode?.querySelector("dl") ?? null),
      runBadges: badgesOf(runNode),
      hasOpenRunNote:
        runNode?.querySelector("button") !== null && runNode?.querySelector("button") !== undefined,
      headings,
      activeElements: article.querySelectorAll(
        "a[href], img, iframe, script, embed, object, video, audio",
      ).length,
    };
  }

  return {
    mounted: true,
    heading: text(root.querySelector("h2")),
    dimmed: root.getAttribute("data-dimmed") === "true",
    busy: root.getAttribute("aria-busy") === "true",
    runNow: {
      present: button !== null,
      label: text(button),
      name: button?.getAttribute("aria-label") ?? "",
      disabled: button?.getAttribute("aria-disabled") === "true",
      busy: button?.getAttribute("aria-busy") === "true",
      reason: reasonNode === null ? null : text(reasonNode),
    },
    subline: text(root.querySelector(":scope > p:nth-of-type(1)")),
    strip: {
      text: text(root.querySelector(`.${c.strip}`)),
      badges: badgesOf(root.querySelector(`.${c.strip}`)),
    },
    status: text(root.querySelector(`.${c.statusLine}`)),
    runStatus: {
      heading: text(statusSection?.querySelector("h3") ?? null),
      rows,
      setup:
        callout === null
          ? null
          : {
              heading: text(callout.querySelector(`.${c.calloutHeading}`)),
              body: text(callout.querySelector(`p:not(.${c.calloutHeading})`)),
            },
      sourcesToggle: toggle === null ? null : text(toggle),
      sourcesExpanded: toggle === null ? null : toggle.getAttribute("aria-expanded") === "true",
    },
    list: {
      busy: region?.getAttribute("aria-busy") === "true",
      dimmed: region?.getAttribute("data-dimmed") === "true",
      rows: listRows,
      emptyHeading: emptyBox === null ? null : text(emptyBox.querySelector(`.${c.emptyHeading}`)),
      emptyBody:
        emptyBox === null ? null : text(emptyBox.querySelector(`p:not(.${c.emptyHeading})`)),
      showMore: more === null ? null : text(more),
      errorText: listError === null ? null : text(listError),
    },
    layout: {
      readerOpen: layoutNode?.getAttribute("data-reader-open") ?? null,
      mode: layoutNode?.getAttribute("data-layout") ?? null,
    },
    reader,
  };
}

// ---------------------------------------------------------------------------
// The transcript: every change of the status line and the Current run row

/**
 * Starts recording each change of the polite status line and of the Current run row (a run held
 * for a second by the fixture shows `Running` and its stage words), so a spec can assert the
 * sequence 07-UAT item 2 names. Replaces an earlier recording. The first record is the state now.
 */
export function rendererStartTranscript(
  rootClass: string,
  statusClass: string,
  runStatusClass: string,
  currentLabel: string,
): boolean {
  const state = window.__cccResearch ?? {};
  window.__cccResearch = state;
  state.observer?.disconnect();
  const records: TranscriptRecord[] = [];
  state.records = records;
  const root = document.querySelector(`section.${rootClass}`);
  if (root === null) return false;
  const F = [
    () => {
      const status = (root.querySelector(`.${statusClass}`)?.textContent ?? "").trim();
      let current: string | null = null;
      const terms = root.querySelectorAll(`section.${runStatusClass} dl > dt`);
      for (let i = 0; i < terms.length; i += 1) {
        const term = terms[i] as RNode;
        if ((term.textContent ?? "").trim() === currentLabel) {
          current = (term.nextElementSibling?.textContent ?? "").replace(/\s+/g, " ").trim();
        }
      }
      const last = records[records.length - 1];
      if (last === undefined || last.status !== status || last.current !== current) {
        records.push({ at: window.performance.now(), status, current });
      }
    },
  ];
  (F[0] as () => void)();
  const observer = new window.MutationObserver(() => (F[0] as () => void)());
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  state.observer = observer;
  return true;
}

/** The records so far (a copy). */
export function rendererReadTranscript(): TranscriptRecord[] {
  return (window.__cccResearch?.records ?? []).map((record) => ({ ...record }));
}

// ---------------------------------------------------------------------------
// Clipboard and scroll spies

/**
 * Replaces `navigator.clipboard.writeText` with a recorder that resolves at once (the real
 * clipboard is never written), and wraps `Element.prototype.scrollIntoView` so each call's
 * `behavior` option is recorded (and still scrolls). Installing twice changes nothing.
 */
export function rendererInstallSpies(): boolean {
  const state = window.__cccResearch ?? {};
  window.__cccResearch = state;
  if (state.originals !== undefined) return false;
  const clipboard: string[] = [];
  const scrolls: Array<{ behavior: string | null }> = [];
  state.clipboard = clipboard;
  state.scrolls = scrolls;
  const originals: Record<string, unknown> = {};
  state.originals = originals;
  originals.writeText = window.navigator.clipboard.writeText;
  // The write is recorded and answered, never passed on: an automated run must not overwrite the
  // owner's clipboard, and a window that is not focused refuses a real write.
  const W = [
    (text: string): Promise<void> => {
      clipboard.push(String(text));
      return Promise.resolve();
    },
  ];
  window.navigator.clipboard.writeText = W[0] as (text: string) => Promise<void>;
  const proto = window.Element.prototype;
  const originalScroll = proto.scrollIntoView;
  originals.scrollIntoView = originalScroll;
  const S = [
    // Anonymous on purpose (keepNames adds no helper) and not an arrow: it needs the caller's `this`.
    function (this: unknown, options?: unknown): void {
      const behavior =
        typeof options === "object" && options !== null
          ? ((options as { behavior?: unknown }).behavior ?? null)
          : null;
      scrolls.push({ behavior: typeof behavior === "string" ? behavior : null });
      originalScroll.call(this, options);
    },
  ];
  proto.scrollIntoView = S[0] as typeof proto.scrollIntoView;
  return true;
}

/** What the spies recorded since they were installed or last cleared. */
export function rendererReadSpies(): {
  clipboard: string[];
  scrolls: Array<{ behavior: string | null }>;
} {
  return {
    clipboard: [...(window.__cccResearch?.clipboard ?? [])],
    scrolls: (window.__cccResearch?.scrolls ?? []).map((entry) => ({ ...entry })),
  };
}

/** Forgets what the spies recorded. */
export function rendererClearSpies(): boolean {
  const state = window.__cccResearch;
  if (state === undefined) return false;
  if (state.clipboard !== undefined) state.clipboard.length = 0;
  if (state.scrolls !== undefined) state.scrolls.length = 0;
  return true;
}

// ---------------------------------------------------------------------------
// Clicking and focus

/** Clicks the `index`th element matching `selector` (zero-based); false when there is none. */
export function rendererClickNth(selector: string, index: number): boolean {
  const found = document.querySelectorAll(selector);
  const node = found[index];
  if (node === undefined) return false;
  node.click();
  return true;
}

/** Clicks the first element matching `selector` whose visible text equals `label`. */
export function rendererClickByText(selector: string, label: string): boolean {
  const found = document.querySelectorAll(selector);
  for (let i = 0; i < found.length; i += 1) {
    const node = found[i] as RNode;
    if ((node.textContent ?? "").replace(/\s+/g, " ").trim() === label) {
      node.click();
      return true;
    }
  }
  return false;
}

/**
 * Clicks the button with the exact text `label` inside the source entry numbered `sourceNumber`
 * (`Open snapshot` and `Copy address` exist once per entry); false when there is none.
 */
export function rendererClickInSource(sourceNumber: string, label: string): boolean {
  const buttons = document.querySelectorAll(`li[data-source="${sourceNumber}"] button`);
  for (let i = 0; i < buttons.length; i += 1) {
    const button = buttons[i] as RNode;
    if ((button.textContent ?? "").replace(/\s+/g, " ").trim() === label) {
      button.click();
      return true;
    }
  }
  return false;
}

/** Clicks the first match twice, back to back; the number of clicks made (0 when nothing matches). */
export function rendererClickTwice(selector: string): number {
  const node = document.querySelector(selector);
  if (node === null) return 0;
  node.click();
  node.click();
  return 2;
}

/**
 * Opens the destination from its tab and presses its Run now button the instant the button
 * exists, before the destination's first status answer can arrive: the one way a press reaches the
 * service while a run is already going on that this window has not been told about (07-UAT item
 * 11). A button that is already aria-disabled is not pressed (the answer says so).
 */
export async function rendererMountAndPress(
  tabSelector: string,
  buttonSelector: string,
  maxMs: number,
): Promise<{ clicked: boolean; waitedMs: number; disabledAtSight: boolean }> {
  const started = window.performance.now();
  document.querySelector(tabSelector)?.click();
  for (;;) {
    const waitedMs = window.performance.now() - started;
    const button = document.querySelector(buttonSelector);
    if (button !== null) {
      if (button.getAttribute("aria-disabled") === "true") {
        return { clicked: false, waitedMs, disabledAtSight: true };
      }
      button.click();
      return { clicked: true, waitedMs, disabledAtSight: false };
    }
    if (waitedMs > maxMs) return { clicked: false, waitedMs, disabledAtSight: false };
    await new Promise<void>((done) => window.setTimeout(done, 0));
  }
}

/** Puts focus on the Run now button of the header; false when there is none. */
export function rendererFocusRunNow(runBoxClass: string): boolean {
  const button = document.querySelector(`.${runBoxClass} button`);
  if (button === null) return false;
  button.focus();
  return document.activeElement === button;
}

/** The computed `scroll-behavior` of an element and of every ancestor up to the document. */
export function rendererReadScrollBehaviour(selector: string): string[] {
  const values: string[] = [];
  let node: RNode | null = document.querySelector(selector);
  while (node !== null) {
    values.push(getComputedStyle(node).getPropertyValue("scroll-behavior"));
    node = node.parentElement;
  }
  return values;
}

/** The focused element as the keyboard items need it. */
export interface ResearchFocus {
  tag: string;
  classes: string;
  name: string;
  text: string;
  /** `data-source` of the source entry the focus is in, or null. */
  sourceNumber: string | null;
  /** `data-cite` of a citation button, or null. */
  cite: string | null;
  inReader: boolean;
  inRow: boolean;
  focusVisible: boolean;
  outlineStyle: string;
  outlineWidth: string;
  boxShadow: string;
}

export function rendererReadFocus(readerClass: string, rowClass: string): ResearchFocus | null {
  const node = document.activeElement;
  if (node === null || node === document.body) return null;
  const style = getComputedStyle(node);
  const label = node.getAttribute("aria-label");
  const own = (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  return {
    tag: node.tagName.toLowerCase(),
    classes: node.getAttribute("class") ?? "",
    name: label !== null && label !== "" ? label : own !== "" ? own : node.tagName.toLowerCase(),
    text: own,
    sourceNumber: node.closest("li[data-source]")?.getAttribute("data-source") ?? null,
    cite: node.getAttribute("data-cite"),
    inReader: node.closest(`.${readerClass}`) !== null,
    inRow: node.closest(`li.${rowClass}`) !== null,
    focusVisible: node.matches(":focus-visible"),
    outlineStyle: style.outlineStyle,
    outlineWidth: style.outlineWidth,
    boxShadow: style.boxShadow,
  };
}

// ---------------------------------------------------------------------------
// Layout and article geometry

export interface ResearchLayoutFacts {
  found: boolean;
  /** `data-layout` of the grid, `data-reader-open` too. */
  mode: string | null;
  readerOpen: string | null;
  /** Width of the grid in CSS pixels and the root font size, to compare with 48rem. */
  gridWidth: number;
  rootFontPx: number;
  list: { display: string; left: number; right: number; top: number; width: number } | null;
  reader: { display: string; left: number; right: number; top: number; width: number } | null;
  /** How far the destination and the grid scroll sideways (scrollWidth minus clientWidth). */
  overflowRoot: number;
  overflowGrid: number;
  backToReportsVisible: boolean;
}

export function rendererReadLayout(
  rootClass: string,
  layoutClass: string,
  listCellClass: string,
  readerCellClass: string,
  readerClass: string,
): ResearchLayoutFacts {
  const root = document.querySelector(`section.${rootClass}`);
  const grid = document.querySelector(`.${layoutClass}`);
  if (root === null || grid === null) {
    return {
      found: false,
      mode: null,
      readerOpen: null,
      gridWidth: 0,
      rootFontPx: 0,
      list: null,
      reader: null,
      overflowRoot: 0,
      overflowGrid: 0,
      backToReportsVisible: false,
    };
  }
  const list = grid.querySelector(`.${listCellClass}`);
  const reader = grid.querySelector(`.${readerCellClass}`);
  const cell = [
    (n: RNode | null) => {
      if (n === null) return null;
      const box = n.getBoundingClientRect();
      return {
        display: getComputedStyle(n).display,
        left: box.left,
        right: box.right,
        top: box.top,
        width: box.width,
      };
    },
  ];
  const article = grid.querySelector(`article.${readerClass}`);
  const back = article?.querySelector(":scope > button") ?? null;
  return {
    found: true,
    mode: grid.getAttribute("data-layout"),
    readerOpen: grid.getAttribute("data-reader-open"),
    gridWidth: grid.getBoundingClientRect().width,
    rootFontPx: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    list: (cell[0] as (n: RNode | null) => ResearchLayoutFacts["list"])(list),
    reader: (cell[0] as (n: RNode | null) => ResearchLayoutFacts["reader"])(reader),
    overflowRoot: root.scrollWidth - root.clientWidth,
    overflowGrid: grid.scrollWidth - grid.clientWidth,
    backToReportsVisible: back !== null && back.offsetParent !== null,
  };
}

export interface ArticleFacts {
  found: boolean;
  findingCount: number;
  /** The rendered width of the reader in px (its prose column). */
  articleWidthPx: number;
  /** Computed `max-width` of the reader in px, and the width of a probe of exactly 68ch in it. */
  maxWidthPx: number;
  measure68chPx: number;
  fontPx: number;
  rootFontPx: number;
  /** Computed `line-height` of a finding's text in px. */
  textLeadingPx: number;
  textFontPx: number;
  textWeight: string;
  quoteLeadingPx: number;
  /** The gap between findings, and the spacing tokens it should equal, all in px. */
  itemGapPx: number;
  spaceLgPx: number;
  spaceXlPx: number;
  /** Margin above each `h4` section heading outside the unavailable notice, in px. */
  headingMarginTopPx: number[];
  /** Truncation: any element in the reader that clamps lines, ellipsises or hides overflow. */
  clamped: string[];
  /** The widest the reader or a descendant is beyond the reader's own width. */
  overflowX: number;
}

export function rendererReadArticle(
  readerClass: string,
  itemClass: string,
  itemsClass: string,
  textClass: string,
  quoteClass: string,
  unavailableClass: string,
): ArticleFacts {
  const none: ArticleFacts = {
    found: false,
    findingCount: 0,
    articleWidthPx: 0,
    maxWidthPx: 0,
    measure68chPx: 0,
    fontPx: 0,
    rootFontPx: 0,
    textLeadingPx: 0,
    textFontPx: 0,
    textWeight: "",
    quoteLeadingPx: 0,
    itemGapPx: 0,
    spaceLgPx: 0,
    spaceXlPx: 0,
    headingMarginTopPx: [],
    clamped: [],
    overflowX: 0,
  };
  const article = document.querySelector(`article.${readerClass}`);
  if (article === null) return none;
  const P = [
    (value: string): number => {
      const probe = document.createElement("div");
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      probe.style.width = value;
      article.appendChild(probe);
      const width = probe.getBoundingClientRect().width;
      probe.remove();
      return width;
    },
  ];
  const px = P[0] as (value: string) => number;
  const style = getComputedStyle(article);
  const textNode = article.querySelector(`.${textClass}`);
  const quoteNode = article.querySelector(`blockquote.${quoteClass}`);
  const textStyle = textNode === null ? null : getComputedStyle(textNode);
  const quoteStyle = quoteNode === null ? null : getComputedStyle(quoteNode);
  const list = article.querySelector(`ol.${itemsClass}`);
  const headingMargins: number[] = [];
  const headings = article.querySelectorAll("h4");
  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i] as RNode;
    if (heading.closest(`section.${unavailableClass}`) !== null) continue;
    headingMargins.push(Number.parseFloat(getComputedStyle(heading).marginTop));
  }
  const clamped: string[] = [];
  const everything = article.querySelectorAll("*");
  for (let i = 0; i < everything.length; i += 1) {
    const node = everything[i] as RNode;
    const cs = getComputedStyle(node);
    const clamp = cs.getPropertyValue("-webkit-line-clamp");
    const hidesOverflow = cs.overflow === "hidden" && node.scrollHeight > node.clientHeight + 1;
    if ((clamp !== "none" && clamp !== "") || cs.textOverflow === "ellipsis" || hidesOverflow) {
      clamped.push(
        `${node.tagName.toLowerCase()}.${node.getAttribute("class") ?? ""}`.slice(0, 80),
      );
    }
  }
  let overflowX = 0;
  const reach = article.getBoundingClientRect().right;
  for (let i = 0; i < everything.length; i += 1) {
    const overshoot = (everything[i] as RNode).getBoundingClientRect().right - reach;
    if (overshoot > overflowX) overflowX = overshoot;
  }
  return {
    found: true,
    findingCount: article.querySelectorAll(`li.${itemClass}`).length,
    articleWidthPx: article.getBoundingClientRect().width,
    maxWidthPx: Number.parseFloat(style.maxWidth),
    measure68chPx: px("68ch"),
    fontPx: Number.parseFloat(style.fontSize),
    rootFontPx: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    textLeadingPx: textStyle === null ? 0 : Number.parseFloat(textStyle.lineHeight),
    textFontPx: textStyle === null ? 0 : Number.parseFloat(textStyle.fontSize),
    textWeight: textStyle === null ? "" : textStyle.fontWeight,
    quoteLeadingPx: quoteStyle === null ? 0 : Number.parseFloat(quoteStyle.lineHeight),
    itemGapPx: list === null ? 0 : Number.parseFloat(getComputedStyle(list).rowGap),
    spaceLgPx: px("var(--ccc-space-lg)"),
    spaceXlPx: px("var(--ccc-space-xl)"),
    headingMarginTopPx: headingMargins,
    clamped,
    overflowX,
  };
}

// ---------------------------------------------------------------------------
// Overview cards

export interface CardFacts {
  title: string;
  presentation: string | null;
  heading: string;
  body: string;
}

/** Every `section.ccc-card` on the page: its title, presentation, state heading and body copy. */
export function rendererReadCards(cardClass: string): CardFacts[] {
  const cards = document.querySelectorAll(`section.${cardClass}`);
  const out: CardFacts[] = [];
  for (let i = 0; i < cards.length; i += 1) {
    const card = cards[i] as RNode;
    out.push({
      title: (card.querySelector("h3")?.textContent ?? "").trim(),
      presentation: card.getAttribute("data-presentation"),
      heading: (card.querySelector(".ccc-state-heading")?.textContent ?? "").trim(),
      body: (card.querySelector(".ccc-state-body")?.textContent ?? "").trim(),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading view (item 10)

export interface ReadingViewFacts {
  found: boolean;
  /** Elements in the rendered body that could load or run something. */
  images: number;
  frames: number;
  scripts: number;
  embeds: number;
  internalEmbeds: number;
  anchors: Array<{ href: string; text: string }>;
  /** The visible text of every `pre` code block in the rendered body. */
  codeBlocks: string[];
  /** The rendered body's text. */
  text: string;
}

/**
 * The rendered body of the note in the active Reading view: what a reader would see. Images,
 * frames, scripts and embeds are counted everywhere in the rendered note, the Properties panel
 * included (none may exist anywhere); links, code blocks and the text come from the Markdown body
 * alone, the Properties panel (the metadata container) left out.
 */
export function rendererReadReadingView(): ReadingViewFacts {
  const view = document.querySelector(
    ".workspace-leaf.mod-active .markdown-reading-view .markdown-preview-sizer",
  );
  if (view === null) {
    return {
      found: false,
      images: 0,
      frames: 0,
      scripts: 0,
      embeds: 0,
      internalEmbeds: 0,
      anchors: [],
      codeBlocks: [],
      text: "",
    };
  }
  const body = view.cloneNode(true);
  const panels = body.querySelectorAll(".metadata-container, .mod-header");
  for (let i = 0; i < panels.length; i += 1) (panels[i] as RNode).remove();
  const anchors: Array<{ href: string; text: string }> = [];
  const links = body.querySelectorAll("a");
  for (let i = 0; i < links.length; i += 1) {
    const link = links[i] as RNode;
    anchors.push({
      href: link.getAttribute("href") ?? link.getAttribute("data-href") ?? "",
      text: (link.textContent ?? "").trim(),
    });
  }
  const blocks: string[] = [];
  const pre = body.querySelectorAll("pre");
  for (let i = 0; i < pre.length; i += 1) {
    // The Copy button of a code block sits inside the pre; the text is the code element's.
    const block = pre[i] as RNode;
    blocks.push((block.querySelector("code") ?? block).textContent ?? "");
  }
  return {
    found: true,
    images: view.querySelectorAll("img").length,
    frames: view.querySelectorAll("iframe").length,
    scripts: view.querySelectorAll("script").length,
    embeds: view.querySelectorAll("embed, object, video, audio").length,
    internalEmbeds: view.querySelectorAll(".internal-embed, .markdown-embed").length,
    anchors,
    codeBlocks: blocks,
    text: body.textContent ?? "",
  };
}
