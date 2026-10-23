/**
 * The core items of the Settings destination in the Phase 8 UAT (plan 08-22, DIAG-01, SC3, D-15 to
 * D-18, D-44): every section reachable by keyboard and pointer with deep-link focus, and (added by
 * the later tasks of the plan) registering a project, the launchers, paths, reduced motion,
 * security and schedules, the service stopped, the keyboard walk, live contrast and privacy.
 *
 * Every case drives the command center's own Settings destination, never Obsidian's native settings
 * dialog, which the runner cannot attach to (05.2 D-09). Everything runs inside the run's sandbox:
 * its own runtime folder, Claude config folder, store and throwaway vault. The service comes from
 * `startResearchEnvironment`, so a gesture health check (opening Security, Paths or Diagnostics, or
 * pressing Run checks again) asks about a nonexistent `ccc-uat-` research-key account and never the
 * owner's. No case launches an app. Authored and CI-verified only (D-15); the live behaviour is
 * first seen in the orchestrator's run at the final head (D-30).
 */
import { browser, expect } from "@wdio/globals";
import { Key } from "webdriverio";
import { assertSandboxConnected } from "../src/driver.js";
import { loadRunContext } from "../src/spec-context.js";
import { HEALTH_TEXT } from "../src/spec-support/health-copy.js";
import { openDiagnostics, pressInRow } from "../src/spec-support/health-support.js";
import {
  type ResearchEnvironment,
  startResearchEnvironment,
} from "../src/spec-support/research-support.js";
import {
  SETTINGS_CLASSES,
  SETTINGS_SECTION_IDS,
  SETTINGS_TEXT,
  sectionLabel,
} from "../src/spec-support/settings-copy.js";
import {
  asSettingsBrowser,
  checkFocusNotMoved,
  checkNavigation,
  checkSectionFocused,
  openSettingsSection,
  openSettingsTab,
  pressSteps,
  readSettings,
  rendererFocusNavItem,
  waitForSettings,
} from "../src/spec-support/settings-support.js";
import { asTasksBrowser, recordResults, WAIT } from "../src/spec-support/tasks-support.js";

const tb = asTasksBrowser(browser);
const sb = asSettingsBrowser(browser);

describe("settings core", function () {
  this.timeout(600_000);
  let env: ResearchEnvironment;

  recordResults(loadRunContext(), (hook) => afterEach(hook as Mocha.Func));

  before(async () => {
    await assertSandboxConnected(tb, { expectedSocketPath: loadRunContext().socketPath });
    env = await startResearchEnvironment();
  });

  after(async () => {
    await env?.stop();
  });

  /** Puts keyboard focus on a nav item (the walks start from one) and checks it landed. */
  async function focusNav(label: string): Promise<void> {
    const landed = await browser.execute(
      rendererFocusNavItem,
      SETTINGS_CLASSES.settingsNav,
      SETTINGS_CLASSES.settingsNavItem,
      label,
    );
    // expect() takes no message in wdio's flavour: the reason is thrown instead.
    if (!landed) throw new Error(`Focus did not land on the ${label} nav item.`);
  }

  /** Presses a key and returns the destination as it reads afterwards. */
  async function press(keys: string | string[]) {
    await browser.keys(keys);
    return readSettings(sb);
  }

  it("[08-UAT#09] Every Settings section is reachable by keyboard and pointer", async () => {
    const labels = SETTINGS_SECTION_IDS.map(sectionLabel);

    // Opening Settings by its tab shows nine nav items, one tab stop, and never moves focus.
    const opened = await openSettingsTab(sb);
    expect(checkFocusNotMoved(opened)).toEqual([]);
    expect(checkNavigation(opened)).toEqual([]);

    // The nav is one tab stop and the arrow keys move focus between items without activating:
    // the section on show does not change while the walk passes over every item.
    await pressSteps(sb, [
      {
        selector: `nav[aria-label="${SETTINGS_TEXT.navLabel}"] button.${SETTINGS_CLASSES.settingsNavItem}`,
        text: labels[0] ?? null,
      },
    ]);
    await focusNav(labels[0] as string);
    for (let index = 1; index < labels.length; index += 1) {
      const read = await press(Key.ArrowDown);
      // The pair names the press, so a failure says which ArrowDown went wrong.
      expect({ press: index, focused: read.nav.findIndex((item) => item.focused) }).toEqual({
        press: index,
        focused: index,
      });
      expect(read.nav.find((item) => item.current)?.label).toBe(labels[0]);
    }
    expect((await press(Key.Home)).nav.findIndex((item) => item.focused)).toBe(0);
    expect((await press(Key.End)).nav.findIndex((item) => item.focused)).toBe(labels.length - 1);
    expect((await press(Key.ArrowDown)).nav.findIndex((item) => item.focused)).toBe(0);

    // Enter opens the focused section and puts focus on its heading; Shift+Tab from the heading
    // returns to the current nav item, so the walk can go on from there.
    for (let index = 1; index < labels.length; index += 1) {
      const label = labels[index] as string;
      await press(Key.ArrowDown);
      const entered = await waitForSettings(
        sb,
        (read) => {
          if (!read.nav[index]?.focused) return [`the ${label} nav item does not hold focus`];
          return [];
        },
        `the ${label} nav item to hold focus`,
        WAIT.short,
      );
      expect(entered.nav[index]?.label).toBe(label);
      await browser.keys(Key.Enter);
      const section = await waitForSettings(
        sb,
        (read) => checkSectionFocused(read, label),
        `the ${label} heading to take focus`,
        WAIT.short,
      );
      expect(section.nav.find((item) => item.current)?.label).toBe(label);
      const back = await press([Key.Shift, Key.Tab]);
      expect({ from: label, inNav: back.focus?.inNav ?? false }).toEqual({
        from: label,
        inNav: true,
      });
      expect(back.nav.find((item) => item.focused)?.label).toBe(label);
    }

    // The pointer reaches every section too, and the heading takes focus there as well.
    for (const id of SETTINGS_SECTION_IDS) {
      const label = sectionLabel(id);
      const read = await openSettingsSection(sb, id);
      const focused = await waitForSettings(
        sb,
        (current) => checkSectionFocused(current, label),
        `the ${label} heading to take focus`,
        WAIT.short,
      );
      expect(checkNavigation(focused)).toEqual([]);
      expect(read.mounted).toBe(true);
    }

    // A setup action's deep link lands on its section heading. Diagnostics opens with the one
    // gesture check (the sandbox research-key account makes it safe); its Launchers row offers
    // `Go to the launchers section`.
    await openDiagnostics(sb);
    await pressInRow(
      sb,
      "launchers",
      `${HEALTH_TEXT.goToPrefix}launchers${HEALTH_TEXT.goToSuffix}`,
    );
    const launchers = await waitForSettings(
      sb,
      (read) => checkSectionFocused(read, sectionLabel("launchers")),
      "the Launchers heading to take focus from the Diagnostics deep link",
      WAIT.short,
    );
    expect(launchers.nav.find((item) => item.current)?.label).toBe(sectionLabel("launchers"));

    // Security's pointer row is a second deep link, to the approvals and tasks section.
    await openSettingsSection(sb, "security");
    await pressSteps(sb, [{ selector: "button", text: SETTINGS_TEXT.goToApprovals }]);
    const approvals = await waitForSettings(
      sb,
      (read) => checkSectionFocused(read, sectionLabel("approvals-tasks")),
      "the Approvals and tasks heading to take focus from the Security pointer",
      WAIT.short,
    );
    expect(approvals.nav.find((item) => item.current)?.label).toBe(sectionLabel("approvals-tasks"));
  });
});
