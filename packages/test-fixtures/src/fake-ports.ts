// Fakes of the Phase 5 cross-phase ports (D-57), for integration tests.
// Mirrors packages/service/src/test-support/fake-ports.ts, which service unit
// tests use because they cannot import this package (PATTERNS fact 2); keep
// the two in step.

import type {
  LaunchGuardResult,
  LaunchGuardTarget,
  LaunchPortResult,
  ProjectRef,
  ProposeForceTerminate,
  SessionLaunchGuard,
  SessionProjectLookup,
  SessionTerminalLauncher,
  TerminalLaunchRequest,
} from "@ccc/domain";

/**
 * A fixed set of registered projects. `resolveByPath` returns the project
 * whose root is the path itself or its nearest ancestor (longest root wins),
 * matching whole path segments only: `/code/alpha-2` is not inside
 * `/code/alpha`.
 */
export class FakeSessionProjectLookup implements SessionProjectLookup {
  readonly #projects: readonly ProjectRef[];

  constructor(projects: readonly ProjectRef[] = []) {
    this.#projects = [...projects];
  }

  resolveByPath(realPath: string): ProjectRef | null {
    let best: ProjectRef | null = null;
    for (const project of this.#projects) {
      const root = project.root.endsWith("/") ? project.root.slice(0, -1) : project.root;
      const inside = realPath === root || realPath.startsWith(`${root}/`);
      if (inside && (best === null || root.length > best.root.length)) {
        best = project;
      }
    }
    return best;
  }

  list(): readonly ProjectRef[] {
    return this.#projects;
  }
}

/** Records every launch request and answers with a configurable result. */
export class FakeSessionTerminalLauncher implements SessionTerminalLauncher {
  readonly requests: TerminalLaunchRequest[] = [];
  result: LaunchPortResult;

  constructor(result: LaunchPortResult = { ok: true }) {
    this.result = result;
  }

  async launch(request: TerminalLaunchRequest): Promise<LaunchPortResult> {
    this.requests.push(request);
    return this.result;
  }
}

/** Records every guard check and answers with a configurable result. */
export class FakeSessionLaunchGuard implements SessionLaunchGuard {
  readonly targets: LaunchGuardTarget[] = [];
  result: LaunchGuardResult;

  constructor(result: LaunchGuardResult = { kind: "clear" }) {
    this.result = result;
  }

  async check(target: LaunchGuardTarget): Promise<LaunchGuardResult> {
    this.targets.push(target);
    return this.result;
  }
}

type ProposeResult = Awaited<ReturnType<ProposeForceTerminate["propose"]>>;

/**
 * Records every force-terminate proposal. Defaults to the pre-Phase-6
 * answer, `approval-unavailable`, so a test must opt in to a proposal id.
 */
export class FakeProposeForceTerminate implements ProposeForceTerminate {
  readonly requests: { readonly runId: string }[] = [];
  result: ProposeResult;

  constructor(result: ProposeResult = { ok: false, reason: "approval-unavailable" }) {
    this.result = result;
  }

  async propose(request: { readonly runId: string }): Promise<ProposeResult> {
    this.requests.push(request);
    return this.result;
  }
}
