import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectActionOutcome, ProjectsActions } from "../projects/projects-actions.js";
import { WidgetFrame } from "../widgets/frame.js";
import { quickActionsWidget } from "../widgets/panels.js";
import { WidgetHostContext } from "../widgets/widget-host.js";
import { ProjectCard } from "./project-card.js";
import { ScanFolders } from "./scan-folders.js";

/**
 * Plan 04-15 visual review against 04-UI-SPEC (Typography; S3, S5, S6, S8).
 *
 * 1. Section headings are "uppercase Label" (600, `--ccc-tracking-label`):
 *    S3 `Suggestions` / `Scan folders`, the card's `★ Pinned` and
 *    `Recent commits`, S6 panel names and `Preview`, S8 `Not available yet`
 *    (muted). One class, `.ccc-section-label`, carries the role; machine-text
 *    mono is not used for them (mono is for bundle IDs, paths and hashes).
 * 2. A launcher status badge is a chip, not a full-width bar that reads as an
 *    input (wave-6 visual note): it does not stretch in the panel's column.
 * 3. Suggestion and scan folder rows keep their buttons in one column at the
 *    row's end, whatever the folder name's width (wave-6 visual note).
 */

const STYLES = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(STYLES);
  return match?.[2] ?? "";
}

const NOW = Date.parse("2026-09-30T12:00:00.000Z");

afterEach(cleanup);

describe("section labels (UI-SPEC Typography: uppercase Label)", () => {
  it("one class carries the role at the Label size, strong weight, tracked and uppercase", () => {
    const body = rule(".ccc-section-label");
    expect(body).toMatch(/font-size:\s*var\(--ccc-text-label\)/);
    expect(body).toMatch(/font-weight:\s*var\(--ccc-weight-strong\)/);
    expect(body).toMatch(/letter-spacing:\s*var\(--ccc-tracking-label\)/);
    expect(body).toMatch(/text-transform:\s*uppercase/);
    expect(rule(".ccc-section-label--muted")).toMatch(/color:\s*var\(--ccc-ink-muted\)/);
  });

  it("S5 Suggestions and Scan folders headings use it", () => {
    const scanRootId = "11111111-1111-4111-8111-111111111111" as never;
    const fail = () => Promise.resolve({ kind: "failed" as const });
    render(
      <ScanFolders
        state={{
          scanRoots: [
            {
              scanRootId,
              displayPath: "~/code",
              depth: 1,
              addedAt: "2026-09-30T11:00:00.000Z",
              lastScannedAt: null,
              scanStatus: "ok",
            } as never,
          ],
          suggestions: [],
          partial: false,
        }}
        actions={{
          addScanRoot: fail,
          removeScanRoot: fail,
          rescan: fail,
          listScanState: fail,
          registerSuggestion: fail,
          dismissSuggestion: fail,
        }}
        now={NOW}
      />,
    );
    for (const name of ["Suggestions", "Scan folders"]) {
      expect(screen.getByRole("heading", { level: 3, name }).className).toContain(
        "ccc-section-label",
      );
    }
  });

  it("the S3 card's Pinned marker and Recent commits use it, not mono", () => {
    const notCalled: () => Promise<ProjectActionOutcome> = () =>
      Promise.reject(new Error("not called"));
    const actions: ProjectsActions = {
      register: notCalled,
      remove: notCalled,
      rename: notCalled,
      pin: notCalled,
      setGithubLink: notCalled,
      refresh: notCalled,
    };
    render(
      <ProjectCard
        row={{
          id: "abcdefghi0123456789abcdef",
          name: "example-project",
          pinned: true,
          gitReadFailed: false,
          github: { kind: "none" },
          observedAt: new Date(NOW - 10_000).toISOString(),
          openItems: null,
          sessionCount: null,
          nextTask: null,
          git: {
            kind: "repo",
            branch: "main",
            detached: false,
            dirty: false,
            remote: null,
            commits: [
              {
                hash: "a1b2c3d4e5f6",
                subject: "Add the settings page",
                committedAt: "2026-09-30T10:00:00.000Z",
              },
            ],
          },
        }}
        displayPath="~/code/example-project"
        now={NOW}
        connection={{ kind: "live" }}
        actions={actions}
        onRemoved={vi.fn()}
      />,
    );
    for (const text of [/Pinned/, /Recent commits/]) {
      const el = screen.getByText(text);
      expect(el.className).toContain("ccc-section-label");
      expect(el.className).not.toContain("ccc-mono-label");
    }
  });

  it("S8's Not available yet group label uses the muted variant", () => {
    render(
      <WidgetHostContext.Provider value={{ switcherAvailable: true }}>
        <WidgetFrame
          definition={quickActionsWidget}
          state={{
            kind: "ready",
            data: {
              launchers: {
                antigravity: "set-up",
                "claude-code": { status: "set-up", terminalLabel: "Terminal" },
                "claude-desktop": "set-up",
              },
            },
            observedAt: "2026-09-30T11:59:00.000Z",
            freshness: "live",
            partiality: { partial: false },
            isEmpty: false,
          }}
          connection={{ kind: "live" }}
          size="medium"
          now={NOW}
          onQuickAction={() => {}}
        />
      </WidgetHostContext.Provider>,
    );
    const label = screen.getByText("Not available yet");
    expect(label.className).toContain("ccc-section-label");
    expect(label.className).toContain("ccc-section-label--muted");
  });
});

describe("launcher panels (S6)", () => {
  it("panel names and the Preview heading use the section label in the source", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const settings = readFileSync(join(here, "launchers-settings.tsx"), "utf8");
    const claude = readFileSync(join(here, "claude-code-panel.tsx"), "utf8");
    const editor = readFileSync(join(here, "template-editor.tsx"), "utf8");
    // Every panel-name h4 (two in launchers-settings, one in claude-code-panel).
    expect(settings.match(/<h4 id=\{headingId\} className="ccc-section-label">/g)).toHaveLength(2);
    expect(claude).toMatch(/<h4 id=\{headingId\} className="ccc-section-label">/);
    expect(editor).toMatch(/<h5 id=\{previewHeadingId\} className="ccc-section-label">/);
  });

  it("a status badge does not stretch across the panel column", () => {
    expect(rule(".ccc-launcher-panel .ccc-badge")).toMatch(/align-self:\s*flex-start/);
  });
});

describe("suggestion and scan folder rows (S5)", () => {
  it("the text column takes the free width so the buttons line up at the row's end", () => {
    for (const row of [".ccc-suggestion-row", ".ccc-scan-folder-row"]) {
      const body = rule(`${row} > .ccc-list-primary`);
      expect(body).toMatch(/flex:\s*1 1 auto/);
      expect(body).toMatch(/min-inline-size:\s*0/);
    }
  });
});
