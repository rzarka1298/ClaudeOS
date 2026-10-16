import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  privateDeepLinkSource,
  reportSource,
  SOURCE_TITLES,
} from "../test-support/research-report-fixtures.js";
import { RESEARCH_NOW_MS, RESEARCH_ZONE } from "../test-support/research-view-fixtures.js";
import { ReportSources } from "./report-sources.js";

/**
 * The Sources section (plan 07-13 Task 2; UI-SPEC R4 "A source entry", RSRCH-03, R-10, R-11): every
 * reference field in order, the address as mono text and never a link, the hash shortened with the
 * full value available, and the sanitise counts as one sentence.
 */

afterEach(cleanup);

function mount(
  sources = [reportSource(1)],
  handlers: { onCopyAddress?: () => void; onOpenSnapshot?: () => void } = {},
) {
  return render(
    <ReportSources
      sources={sources}
      backTo={null}
      onBackToFinding={() => undefined}
      onCopyAddress={handlers.onCopyAddress ?? (() => undefined)}
      onOpenSnapshot={handlers.onOpenSnapshot ?? (() => undefined)}
      now={RESEARCH_NOW_MS}
      zone={RESEARCH_ZONE}
    />,
  );
}

function fields(entry: HTMLElement): Map<string, HTMLElement> {
  const map = new Map<string, HTMLElement>();
  const terms = [...entry.querySelectorAll("dt")];
  for (const dt of terms) {
    const dd = dt.nextElementSibling;
    if (dd instanceof HTMLElement) map.set(dt.textContent ?? "", dd);
  }
  return map;
}

describe("Test 1 (reference fields): every RSRCH-03 field, in order", () => {
  it("lists the ten fields in the contracted order", () => {
    const { container } = mount();
    const entry = container.querySelector("li.ccc-report-source") as HTMLElement;
    expect([...entry.querySelectorAll("dt")].map((dt) => dt.textContent)).toEqual([
      "Type",
      "Access",
      "Address",
      "Author",
      "Published",
      "Retrieved",
      "Content hash",
      "Stable ID",
      "Snapshot",
      "Removed before summarising",
    ]);
  });

  it("shows the type word and the access label with its explanation", () => {
    const { container } = mount();
    const map = fields(container.querySelector("li.ccc-report-source") as HTMLElement);
    expect(map.get("Type")?.textContent).toBe("Feed entry");
    expect(map.get("Access")?.textContent).toContain("Public");
    expect(map.get("Access")?.textContent).toContain("Fetched from a public web address.");
  });

  it("shows the address as mono text, never a link, with a Copy address button", () => {
    const onCopyAddress = vi.fn();
    const { container } = mount([reportSource(1)], { onCopyAddress });
    const address = fields(container.querySelector("li.ccc-report-source") as HTMLElement).get(
      "Address",
    ) as HTMLElement;
    const mono = address.querySelector(".ccc-mono");
    expect(mono?.textContent).toBe("https://changelog.example.invalid/feed/1");
    expect(container.querySelector("a")).toBeNull();
    fireEvent.click(within(address).getByRole("button", { name: "Copy address" }));
    expect(onCopyAddress).toHaveBeenCalledWith("https://changelog.example.invalid/feed/1");
  });

  it("shows a private deep link as mono text with no action", () => {
    const { container } = mount([privateDeepLinkSource(1)]);
    const address = fields(container.querySelector("li.ccc-report-source") as HTMLElement).get(
      "Address",
    ) as HTMLElement;
    expect(address.querySelector(".ccc-mono")?.textContent).toBe(
      "obsidian://open?vault=example&file=sample",
    );
    expect(address.querySelector("button")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });

  it("says Not provided for a missing author and published time", () => {
    const { container } = mount([reportSource(1, { author: null, publishedAt: null })]);
    const map = fields(container.querySelector("li.ccc-report-source") as HTMLElement);
    expect(map.get("Author")?.textContent).toBe("Not provided");
    expect(map.get("Published")?.textContent).toBe("Not provided");
  });

  it("shows the author and the absolute published and retrieved times", () => {
    const { container } = mount();
    const map = fields(container.querySelector("li.ccc-report-source") as HTMLElement);
    expect(map.get("Author")?.textContent).toBe("Example Author");
    expect(map.get("Published")?.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-10-14T07:00:00.000Z",
    );
    expect(map.get("Published")?.textContent).toBe("Oct 14, 7:00 AM");
    expect(map.get("Retrieved")?.textContent).toBe("Oct 14, 10:59 AM");
  });

  it("shortens the content hash to 12 hex characters with the full value in a title and a hidden span", () => {
    const source = reportSource(1);
    const { container } = mount([source]);
    const hash = fields(container.querySelector("li.ccc-report-source") as HTMLElement).get(
      "Content hash",
    ) as HTMLElement;
    const mono = hash.querySelector(".ccc-mono") as HTMLElement;
    expect(mono.textContent).toBe(source.contentHash.slice(0, 12));
    expect(mono.getAttribute("title")).toBe(source.contentHash);
    expect(hash.querySelector(".ccc-visually-hidden")?.textContent).toContain(source.contentHash);
  });

  it("shows the stable id and the snapshot path as mono text with Open snapshot", () => {
    const source = reportSource(1);
    const onOpenSnapshot = vi.fn();
    const { container } = mount([source], { onOpenSnapshot });
    const map = fields(container.querySelector("li.ccc-report-source") as HTMLElement);
    expect(map.get("Stable ID")?.querySelector(".ccc-mono")?.textContent).toBe(source.id);
    const snapshot = map.get("Snapshot") as HTMLElement;
    expect(snapshot.querySelector(".ccc-mono")?.textContent).toBe(source.snapshotPath);
    fireEvent.click(within(snapshot).getByRole("button", { name: "Open snapshot" }));
    expect(onOpenSnapshot).toHaveBeenCalledWith(source.snapshotPath);
  });

  it("writes the removed counts as one sentence, omitting zero counts", () => {
    const { container } = mount([
      reportSource(1, {
        counts: {
          scripts: 2,
          styles: 0,
          comments: 0,
          hiddenBlocks: 1,
          mediaDropped: 0,
          linksDropped: 3,
          controlChars: 0,
          commandLikeLines: 1,
        },
      }),
    ]);
    const removed = fields(container.querySelector("li.ccc-report-source") as HTMLElement).get(
      "Removed before summarising",
    );
    expect(removed?.textContent).toBe("2 scripts, 1 hidden block, 3 links, 1 command-like line");
  });

  it("says Nothing removed when every count is zero", () => {
    const { container } = mount();
    const removed = fields(container.querySelector("li.ccc-report-source") as HTMLElement).get(
      "Removed before summarising",
    );
    expect(removed?.textContent).toBe("Nothing removed");
  });

  it("says Not recorded, never Nothing removed, when the report has no handling entry", () => {
    const { container } = mount([reportSource(1, { counts: null })]);
    const removed = fields(container.querySelector("li.ccc-report-source") as HTMLElement).get(
      "Removed before summarising",
    );
    expect(removed?.textContent).toBe("Not recorded");
  });

  it("numbers the entries with an h5 each and keeps the heading a focus target", () => {
    mount([reportSource(1), reportSource(2)]);
    const headings = screen.getAllByRole("heading", { level: 5 });
    expect(headings.map((h) => h.textContent)).toEqual([
      `1. ${SOURCE_TITLES[0]}`,
      `2. ${SOURCE_TITLES[1]}`,
    ]);
    for (const heading of headings) expect(heading.getAttribute("tabindex")).toBe("-1");
  });
});
