import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DiagnosticsHealthResponse } from "@ccc/domain/diagnostics.js";
import { act, cleanup, render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { ConnectionState } from "../connection-state.js";
import { configureHealth } from "../health/api.js";
import { resetHealthState } from "../health/state.js";
import { HEALTH_NOW, healthResponse } from "../test-support/health-fixtures.js";
import { createInertSettingsHost, type SettingsHost } from "./settings-host.js";
import { PathsSection } from "./settings-paths.js";

/**
 * The Paths section (plan 08-18 Task 1; 08-UI-SPEC S2 Paths and R-F5, D-15, D-16, T-08-46): three
 * read-only display paths in mono, never an input, never an absolute path or a user name, never
 * persisted. The vault and the data folder come from the shared health answer; the socket is the
 * plugin's own resolved path. Every path in these tests uses the placeholder user segment.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE_AWAY = "The companion service isn't running.";
const FAILED_TEXT = "Couldn't run the checks.";
const DESCRIPTION =
  "Where the command center keeps things. These locations are managed by the companion service and can't be changed here.";

const HOME = "/Users/username";

function answer(paths: DiagnosticsHealthResponse["paths"]): DiagnosticsHealthResponse {
  return { ...healthResponse(), paths };
}

const HOME_PATHS: DiagnosticsHealthResponse["paths"] = {
  vault: "~/ExampleVault",
  runtimeDir: "~/.claude-command-center",
  socket: "~/.claude-command-center/svc.sock",
};

interface Fixture {
  readonly host: SettingsHost;
  readonly notify: Mock<(message: string) => void>;
  readonly saveSettings: Mock<() => Promise<void>>;
}

function fixture(
  display: Partial<SettingsHost["display"]> = {},
  settingsOverrides: Partial<SettingsHost["settings"]> = {},
): Fixture {
  const base = createInertSettingsHost();
  const saveSettings = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const host: SettingsHost = {
    ...base,
    settings: { ...base.settings, ...settingsOverrides },
    saveSettings,
    display: {
      ...base.display,
      homeDir: HOME,
      socketPath: `${HOME}/.claude-command-center/svc.sock`,
      userName: "username",
      ...display,
    },
  };
  return { host, notify: vi.fn<(message: string) => void>(), saveSettings };
}

function renderPaths(f: Fixture, options: { connection?: ConnectionState; now?: number } = {}) {
  return render(
    <PathsSection
      host={f.host}
      connection={options.connection ?? { kind: "live" }}
      now={options.now ?? HEALTH_NOW}
      notify={f.notify}
    />,
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

function serve(response: DiagnosticsHealthResponse | Error | "never") {
  const get = vi.fn((_trigger: string): Promise<DiagnosticsHealthResponse> => {
    if (response === "never") return new Promise<DiagnosticsHealthResponse>(() => {});
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve(response);
  });
  configureHealth({ api: { get } });
  return get;
}

/** The `dd` that follows the `dt` named `name`. */
function valueFor(name: string): HTMLElement {
  const term = screen.getByText(name, { selector: "dt" });
  const value = term.nextElementSibling;
  if (!(value instanceof HTMLElement) || value.tagName !== "DD") throw new Error("no dd");
  return value;
}

beforeEach(() => {
  resetHealthState();
});

afterEach(() => {
  cleanup();
  resetHealthState();
  configureHealth(null);
});

describe("Task 1 (tracer): Paths shows the three locations as read-only display paths", () => {
  it("Test 1: renders three dt/dd pairs whose values are code.ccc-setting-path starting `~/`, and no input", async () => {
    serve(answer(HOME_PATHS));
    const f = fixture();
    const { container } = renderPaths(f);
    await flush();

    expect(screen.getByRole("heading", { level: 3, name: "Paths" })).toBeTruthy();
    expect(screen.getByText(DESCRIPTION)).toBeTruthy();
    const terms = [...container.querySelectorAll("dl.ccc-detail-fields > dt")].map(
      (term) => term.textContent,
    );
    expect(terms).toEqual(["Managed vault", "Service data folder", "Service socket"]);
    expect(container.querySelectorAll("dl.ccc-detail-fields > dd")).toHaveLength(3);

    const values = [...container.querySelectorAll("code.ccc-setting-path")].map(
      (code) => code.textContent,
    );
    expect(values).toEqual([
      "~/ExampleVault",
      "~/.claude-command-center",
      "~/.claude-command-center/svc.sock",
    ]);
    expect(values.every((value) => value?.startsWith("~/"))).toBe(true);
    expect(container.querySelector("input, textarea, select, [contenteditable]")).toBeNull();
    expect(valueFor("Managed vault").querySelector("code.ccc-setting-path")).not.toBeNull();
  });

  it("Test 1: the heading is the focus target of a deep link and carries the FIX2B classes", async () => {
    serve(answer(HOME_PATHS));
    const { container } = renderPaths(fixture());
    await flush();
    const title = container.querySelector("h3");
    expect(title?.getAttribute("tabindex")).toBe("-1");
    expect(title?.classList.contains("ccc-settings-section-title")).toBe(true);
  });

  it("Test 2: a socket outside the home folder shows only `…/<parent>/<name>`, with no absolute prefix or user name", async () => {
    serve(answer(HOME_PATHS));
    const f = fixture({ socketPath: "/Volumes/Data/run/svc.sock" });
    const { container } = renderPaths(f);
    await flush();
    expect(valueFor("Service socket").textContent).toContain("…/run/svc.sock");
    const text = container.textContent ?? "";
    expect(text).not.toContain("/Users/");
    expect(text).not.toContain("/home/");
    expect(text).not.toContain("/Volumes");
    expect(text).not.toContain("username");
  });

  it("Test 2: an outside-home path that carries the user name has it masked", async () => {
    serve(answer(HOME_PATHS));
    const f = fixture({ socketPath: "/Volumes/username-backup/svc.sock" });
    const { container } = renderPaths(f);
    await flush();
    expect(valueFor("Service socket").textContent).toContain("…/…/svc.sock");
    expect(container.textContent ?? "").not.toContain("username");
  });

  it("Test 2: a socket under the home folder is shown as `~/...`", async () => {
    serve(answer(HOME_PATHS));
    const f = fixture({ socketPath: `${HOME}/Library/example/svc.sock` });
    const { container } = renderPaths(f);
    await flush();
    expect(valueFor("Service socket").textContent).toContain("~/Library/example/svc.sock");
    expect(container.textContent ?? "").not.toContain("/Users/");
  });

  it("Test 3: with the service away the service-owned rows read Unknown with the reason; the socket still shows", () => {
    const get = serve(answer(HOME_PATHS));
    const f = fixture();
    renderPaths(f, { connection: { kind: "disconnected", reason: "ECONNREFUSED example" } });
    for (const name of ["Managed vault", "Service data folder"]) {
      const value = valueFor(name);
      expect(value.textContent).toContain("Unknown");
      expect(value.textContent).toContain(SERVICE_AWAY);
      expect(value.querySelector("code")).toBeNull();
    }
    expect(valueFor("Service socket").querySelector("code.ccc-setting-path")?.textContent).toBe(
      "~/.claude-command-center/svc.sock",
    );
    // The connection reason text never reaches the DOM, and nothing was fetched.
    expect(document.body.textContent).not.toContain("ECONNREFUSED");
    expect(get).not.toHaveBeenCalled();
  });

  it("Test 3: live with no answer yet shows a skeleton, not a guessed path or a false Unknown", () => {
    serve("never");
    const { container } = renderPaths(fixture());
    expect(container.querySelector("dl")?.getAttribute("aria-busy")).toBe("true");
    expect(valueFor("Managed vault").querySelector(".ccc-skeleton-line")).not.toBeNull();
    expect(valueFor("Managed vault").querySelector("code")).toBeNull();
  });

  it("Test 3: a failed check reads Unknown with the failure reason, never a path", async () => {
    serve(new Error("boom"));
    const { container } = renderPaths(fixture());
    await flush();
    for (const name of ["Managed vault", "Service data folder"]) {
      expect(valueFor(name).textContent).toContain("Unknown");
      expect(valueFor(name).textContent).toContain(FAILED_TEXT);
    }
    expect(container.textContent).not.toContain("boom");
  });

  it("Test 3: a vault the service has not set up reads Unknown with its own reason", async () => {
    serve(answer({ ...HOME_PATHS, vault: null }));
    renderPaths(fixture());
    await flush();
    expect(valueFor("Managed vault").textContent).toContain("Unknown");
    expect(valueFor("Managed vault").textContent).toContain("No managed vault is set up yet.");
    expect(valueFor("Service data folder").querySelector("code")?.textContent).toBe(
      "~/.claude-command-center",
    );
  });

  it("Test 3: an answer older than five minutes shows the Stale badge on the service-owned rows", async () => {
    serve(answer(HOME_PATHS));
    const f = fixture();
    const view = renderPaths(f, { now: HEALTH_NOW });
    await flush();
    expect(view.container.querySelector('.ccc-badge[data-badge="stale"]')).toBeNull();

    view.rerender(
      <PathsSection
        host={f.host}
        connection={{ kind: "live" }}
        now={HEALTH_NOW + 6 * 60_000}
        notify={f.notify}
      />,
    );
    expect(within(valueFor("Managed vault")).getByText("Stale")).toBeTruthy();
    expect(within(valueFor("Service data folder")).getByText("Stale")).toBeTruthy();
    // The plugin's own socket path has no answer to age.
    expect(valueFor("Service socket").querySelector('[data-badge="stale"]')).toBeNull();
  });

  it("Test 3: a socket path the plugin cannot name reads Unknown, not a guessed default", async () => {
    serve(answer(HOME_PATHS));
    renderPaths(fixture({ socketPath: null }));
    await flush();
    expect(valueFor("Service socket").textContent).toContain("Unknown");
    expect(valueFor("Service socket").querySelector("code")).toBeNull();
  });

  it("Test 3: a path value that is not a display path is never shown", async () => {
    // A hostile or buggy answer: the section re-checks the shape before it renders a value.
    const hostile = {
      ...answer(HOME_PATHS),
      paths: { vault: "/Users/username/ExampleVault", runtimeDir: "~/a", socket: "~/a/s" },
    } as unknown as DiagnosticsHealthResponse;
    serve(hostile);
    const { container } = renderPaths(fixture());
    await flush();
    expect(container.textContent).not.toContain("/Users/");
    expect(valueFor("Managed vault").textContent).toContain("Unknown");
  });

  it("Test 4: opening Paths refreshes the shared health state once, with the owner's gesture, and writes no setting", async () => {
    const get = serve(answer(HOME_PATHS));
    const f = fixture();
    const before = JSON.stringify(f.host.settings);
    renderPaths(f);
    await flush();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("gesture");
    expect(f.saveSettings).not.toHaveBeenCalled();
    expect(JSON.stringify(f.host.settings)).toBe(before);
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("Test 4: nothing in the host settings or their JSON holds a displayed path", async () => {
    serve(answer(HOME_PATHS));
    const f = fixture();
    renderPaths(f);
    await flush();
    const written = JSON.stringify(f.host.settings);
    expect(written).not.toContain("ExampleVault");
    expect(written).not.toContain(".claude-command-center");
  });
});

describe("the Paths source", () => {
  const source = readFileSync(join(HERE, "settings-paths.tsx"), "utf8");

  it("adds no live region of its own and no input (FIX2B)", () => {
    expect(source).not.toMatch(/role=["']status["']|aria-live|<input|<textarea|<select/);
  });

  it("starts no timer and reads no clock", () => {
    expect(source).not.toMatch(/\bset(?:Interval|Timeout)\s*\(|\bDate\.now\s*\(/);
  });
});
