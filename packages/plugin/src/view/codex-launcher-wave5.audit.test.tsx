import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import type { ConnectionState } from "../connection-state.js";
import {
  CODEX_USER_INSTALL,
  fakeLaunchersActions,
  NOTHING_SAVED,
  withCodexDetection,
} from "../test-support/launchers-fixtures.js";
import { ClaudeCodePanel } from "./claude-code-panel.js";
import { CodexLauncherPanel } from "./codex-launcher-panel.js";
import { createLaunchersSession } from "./launchers-settings.js";

/** Wave 5 audit (plan 05.1-31 truth 9): no inline style, no new colour, existing classes. */
const here = dirname(fileURLToPath(import.meta.url));
afterEach(cleanup);

function sessions() {
  const s = createLaunchersSession();
  s.detection.value = withCodexDetection([CODEX_USER_INSTALL]);
  s.configs.value = {
    ...NOTHING_SAVED,
    codex: { executableDisplay: "~/.local/bin/codex", args: [], tested: true },
  };
  return s;
}
const CONNS: ConnectionState[] = [
  { kind: "live" },
  { kind: "disconnected", reason: "service-unreachable" },
];

describe("Codex launcher panel and terminal radios audit", () => {
  it.each(CONNS)("renders no inline style and labelled buttons ($kind)", (connection) => {
    const actions = fakeLaunchersActions();
    const a = render(
      <CodexLauncherPanel
        actions={actions}
        session={sessions()}
        connection={connection}
        now={0}
        sampleDisplayPath="~/code/example-project"
      />,
    );
    const b = render(
      <ClaudeCodePanel
        actions={actions}
        session={sessions()}
        connection={connection}
        now={0}
        sampleDisplayPath="~/code/example-project"
      />,
    );
    for (const root of [a.container, b.container]) {
      expect(root.querySelectorAll("[style]")).toHaveLength(0);
      for (const btn of root.querySelectorAll("button")) {
        expect(
          (btn.getAttribute("aria-label") ?? btn.textContent ?? "").trim().length,
        ).toBeGreaterThan(0);
      }
    }
    const radios = b.container.querySelectorAll('input[type="radio"]');
    expect(radios.length).toBeGreaterThanOrEqual(3);
    if (connection.kind === "disconnected") {
      for (const r of radios) expect(r.getAttribute("aria-disabled")).toBe("true");
    }
  });

  it("the Codex panel and kit sources add no style prop, colour literal or motion", () => {
    for (const file of [
      "codex-launcher-panel.tsx",
      "launcher-panel-kit.tsx",
      "claude-code-panel.tsx",
    ]) {
      const source = readFileSync(join(here, file), "utf8");
      expect(source, file).not.toMatch(/\bstyle\s*=/);
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(source, file).not.toMatch(/\b(?:rgba?|hsla?)\(/);
      expect(source, file).not.toMatch(/animation|transition/i);
    }
  });
});
