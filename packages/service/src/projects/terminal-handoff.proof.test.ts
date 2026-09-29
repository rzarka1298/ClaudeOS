/**
 * The service-written-script proof (D-17, PROJ-06, PROJ-13, T-04-01).
 *
 * `@ccc/launchers`' own proof test executes scripts it renders itself. This
 * one closes the remaining gap: it drives the real launch service, with a
 * stored Claude Code configuration and a registered project whose folder
 * name is hostile, through the real Terminal.app adapter and the real script
 * directory — and then executes EXACTLY the file the service wrote, through
 * its kernel shebang, the way Terminal would. Only `/usr/bin/open` is
 * replaced: the spawner double runs the script path it was handed instead.
 *
 * Asserted: the stub `claude` saw the configured arguments verbatim with
 * `{projectPath}` replaced by the project's realpath as one element; its
 * working directory was that realpath; no PWNED canary exists anywhere under
 * the temp root; the script deleted itself.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ProjectId } from "@ccc/domain";
import { shQuote } from "@ccc/launchers";
import {
  applyMigrations,
  getProject,
  insertProject,
  type OperationalStore,
  openStore,
  saveLauncherConfig,
} from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLaunchService } from "./launch-service.js";
import { createStoreProjectLookup } from "./project-lookup.js";
import { ensureScriptDir } from "./script-dir.js";
import type { Spawner, SpawnOutcome } from "./spawner.js";

const NUL = String.fromCharCode(0);
const HOSTILE_FOLDER = `it's $(touch PWNED) "x"`;

let root: string;
let store: OperationalStore;
let projectDir: string;
let projectId: ProjectId;
let scriptDir: string;
let stubPath: string;
let argsFile: string;
let cwdFile: string;
let originDir: string;
const handedOff: string[] = [];

function findCanaries(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(
    (entry) => basename(entry) === "PWNED",
  );
}

/** Stands in for `/usr/bin/open -b com.apple.Terminal <script>`: runs the script itself. */
const executingSpawner: Spawner = {
  run(argv): Promise<SpawnOutcome> {
    const script = argv[3] ?? "";
    handedOff.push(script);
    execFileSync(script, [], {
      cwd: originDir,
      env: { PATH: "/usr/bin:/bin", SHELL: "/usr/bin/true" },
      timeout: 10_000,
    });
    return Promise.resolve({ exitCode: 0, errno: null, stderrClass: "none", timedOut: false });
  },
};

beforeEach(() => {
  handedOff.length = 0;
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ccc-handoff-proof-")));
  store = openStore(join(root, "operational.db"));
  applyMigrations(store.db);
  projectDir = join(root, "projects", HOSTILE_FOLDER);
  mkdirSync(projectDir, { recursive: true });
  projectId = insertProject(store.db, { path: projectDir, displayName: "Hostile" }).record
    .projectId;
  scriptDir = ensureScriptDir(join(root, "runtime"));
  originDir = join(root, "origin");
  mkdirSync(originDir);
  argsFile = join(root, "args.bin");
  cwdFile = join(root, "cwd.txt");
  stubPath = join(root, "bin", "claude-stub");
  mkdirSync(join(root, "bin"));
  writeFileSync(
    stubPath,
    [
      "#!/bin/sh",
      `printf '%s\\0' "$@" > ${shQuote(argsFile)}`,
      `pwd -P > ${shQuote(cwdFile)}`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(stubPath, 0o755);
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("the launch service's own script, executed (D-17, PROJ-06, PROJ-13)", () => {
  it("runs the configured claude at the hostile project root verbatim, then deletes itself", async () => {
    saveLauncherConfig(store.db, "claude-code", {
      executablePath: stubPath,
      args: ["--flag", "{projectPath}"],
      terminal: { kind: "terminal-app" },
    });
    const service = createLaunchService({
      store,
      spawner: executingSpawner,
      lookup: createStoreProjectLookup(store),
      collector: {
        refresh: () => undefined,
        onRegistryChanged: () => undefined,
        gitState: () => null,
      },
      logger: { info: () => undefined, warn: () => undefined },
      scriptDir,
    });

    await expect(service.launch({ projectId, action: "claude-code" })).resolves.toEqual({
      ok: true,
    });

    expect(handedOff).toHaveLength(1);
    const script = handedOff[0] ?? "";
    expect(script.startsWith(`${scriptDir}/`)).toBe(true);
    const recorded = readFileSync(argsFile, "utf8").split(NUL);
    recorded.pop();
    const projectRealpath = realpathSync.native(projectDir);
    expect(recorded).toEqual(["--flag", projectRealpath]);
    expect(readFileSync(cwdFile, "utf8")).toBe(`${projectRealpath}\n`);
    expect(findCanaries(root)).toEqual([]);
    expect(existsSync(script)).toBe(false);
    expect(readdirSync(scriptDir)).toEqual([]);
    expect(getProject(store.db, projectId)?.lastOpenedAt).not.toBeNull();
  });
});
