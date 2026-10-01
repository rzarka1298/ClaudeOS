import type { ProjectId, ProjectView } from "@ccc/domain";
import { EMPTY_PROJECTS_SNAPSHOT } from "@ccc/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type LaunchTimerControls,
  launchStatus,
  launchStatusKey,
  resetLaunchStatus,
  retainLaunchStatus,
  setLaunchError,
  setLaunchOpening,
  setLaunchResult,
} from "./launch-status.js";
import { applyProjectsDelta, applyProjectsSnapshot, resetProjectsState } from "./projects-state.js";

/**
 * How long a launch status lives (RR-04; wave-5 review findings 5 and 7).
 *
 * - Finding 5: an error persists "until the next launch from that row, a
 *   launcher-settings save, or reload". A save reaches the plugin as a
 *   `projects.updated` delta carrying `launchers`; it clears the launcher
 *   actions' errors. A `no-github-remote` error clears once the project has a
 *   GitHub link.
 * - Finding 7: the store is shared by every command-center view, so closing
 *   one view must not wipe the statuses another open view still shows. It is
 *   reset only when the LAST view releases it.
 */

const A = "abcdefghi0123456789abcd01" as ProjectId;
const B = "abcdefghi0123456789abcd02" as ProjectId;

function view(projectId: ProjectId, overrides: Partial<ProjectView> = {}): ProjectView {
  return {
    projectId,
    displayName: `project-${projectId.slice(-2)}`,
    displayPath: "~/code/example-project",
    pinned: false,
    lastOpenedAt: null,
    observedAt: "2026-09-30T12:00:00.000Z",
    gitReadFailed: false,
    git: { kind: "repo", branch: "main", detached: false, dirty: false, commits: [], remote: null },
    github: { kind: "none" },
    ...overrides,
  };
}

function seed(): void {
  applyProjectsSnapshot({
    state: {
      projects: { projects: [view(A), view(B)], launchers: EMPTY_PROJECTS_SNAPSHOT.launchers },
    },
  } as unknown as Parameters<typeof applyProjectsSnapshot>[0]);
}

function delta(payload: Record<string, unknown>): void {
  applyProjectsDelta({
    id: 1,
    type: "projects.updated",
    occurredAt: "2026-09-30T12:00:01.000Z",
    payload: { upserted: [], removed: [], ...payload },
  });
}

function fakeTimers(): LaunchTimerControls {
  let next = 1;
  return { setTimer: () => next++, clearTimer: vi.fn() };
}

afterEach(() => {
  resetLaunchStatus();
  resetProjectsState();
});

describe("a launcher save clears launch errors (finding 5, RR-04)", () => {
  it("clears every launcher action's error when a delta carries launchers", () => {
    seed();
    setLaunchError(launchStatusKey(A, "claude-code"), "launcher-not-configured");
    setLaunchError(launchStatusKey(B, "antigravity"), "app-not-found");
    setLaunchError(launchStatusKey(null, "claude-desktop"), "app-not-found");
    delta({
      launchers: {
        ...EMPTY_PROJECTS_SNAPSHOT.launchers,
        antigravity: "set-up",
      },
    });
    expect([...launchStatus.value.keys()]).toEqual([]);
  });

  it("keeps Finder errors, in-flight launches and successes", () => {
    seed();
    setLaunchError(launchStatusKey(A, "finder"), "project-missing");
    setLaunchOpening(launchStatusKey(A, "claude-code"));
    setLaunchResult(
      launchStatusKey(B, "antigravity"),
      { kind: "success", at: "2026-09-30T12:00:00.000Z" },
      fakeTimers(),
    );
    delta({ launchers: EMPTY_PROJECTS_SNAPSHOT.launchers });
    expect(launchStatus.value.get(launchStatusKey(A, "finder"))?.kind).toBe("error");
    expect(launchStatus.value.get(launchStatusKey(A, "claude-code"))?.kind).toBe("opening");
    expect(launchStatus.value.get(launchStatusKey(B, "antigravity"))?.kind).toBe("success");
  });

  it("a delta without launchers clears nothing", () => {
    seed();
    setLaunchError(launchStatusKey(A, "claude-code"), "launcher-not-configured");
    delta({});
    expect(launchStatus.value.get(launchStatusKey(A, "claude-code"))?.kind).toBe("error");
  });
});

describe("no-github-remote clears once a GitHub link exists (finding 5)", () => {
  it("clears the project's no-github-remote error when its upsert carries a GitHub target", () => {
    seed();
    setLaunchError(launchStatusKey(A, "github"), "no-github-remote");
    setLaunchError(launchStatusKey(B, "github"), "no-github-remote");
    delta({
      upserted: [
        view(A, {
          github: { kind: "github", label: "github.com/owner/repo", source: "override" },
        }),
      ],
    });
    expect(launchStatus.value.has(launchStatusKey(A, "github"))).toBe(false);
    expect(launchStatus.value.get(launchStatusKey(B, "github"))?.kind).toBe("error");
  });

  it("keeps a GitHub error that is not no-github-remote", () => {
    seed();
    setLaunchError(launchStatusKey(A, "github"), "spawn-failed");
    delta({
      upserted: [
        view(A, { github: { kind: "github", label: "github.com/owner/repo", source: "remote" } }),
      ],
    });
    expect(launchStatus.value.get(launchStatusKey(A, "github"))?.kind).toBe("error");
  });

  it("a full resync that shows the link clears it too", () => {
    seed();
    setLaunchError(launchStatusKey(A, "github"), "no-github-remote");
    applyProjectsSnapshot({
      state: {
        projects: {
          projects: [
            view(A, {
              github: { kind: "github", label: "github.com/owner/repo", source: "remote" },
            }),
          ],
          launchers: EMPTY_PROJECTS_SNAPSHOT.launchers,
        },
      },
    } as unknown as Parameters<typeof applyProjectsSnapshot>[0]);
    expect(launchStatus.value.has(launchStatusKey(A, "github"))).toBe(false);
  });
});

describe("the store is reset only when the last view releases it (finding 7)", () => {
  it("closing one of two views keeps the statuses; closing the last resets", () => {
    const releaseFirst = retainLaunchStatus();
    const releaseSecond = retainLaunchStatus();
    setLaunchError(launchStatusKey(A, "claude-code"), "launcher-not-configured");
    releaseFirst();
    expect(launchStatus.value.size).toBe(1);
    releaseSecond();
    expect(launchStatus.value.size).toBe(0);
  });

  it("a release is idempotent: a double close cannot drop another view's hold", () => {
    const releaseFirst = retainLaunchStatus();
    const releaseSecond = retainLaunchStatus();
    setLaunchError(launchStatusKey(A, "claude-code"), "launcher-not-configured");
    releaseFirst();
    releaseFirst();
    expect(launchStatus.value.size).toBe(1);
    releaseSecond();
    expect(launchStatus.value.size).toBe(0);
  });
});
