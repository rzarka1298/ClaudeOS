import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TASK_ATTENTION_PATH,
  TASK_COUNTS_PATH,
  TASK_LIST_PATH,
  type TaskAttentionResponse,
  type TaskCountsResponse,
  type TaskFilter,
  type TaskListResponse,
  VAULT_SETUP_PATH,
} from "@ccc/domain";
import { parseTaskNote } from "@ccc/vault-repo";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authedRequest,
  handshake,
  setUpServiceEnvironment,
  tearDownServiceEnvironment,
} from "./approval-int-support.js";
import { startServiceForTest, type TestServiceHandle } from "./service-harness.js";
import { withTempSocketDir } from "./socket-fixture.js";
import {
  expectedCounts,
  expectedIds,
  type GeneratedTask,
  hashVaultFiles,
  utcDay,
} from "./task-fixtures.js";

/**
 * Plan 06-28 Task 1 (D-45, D-46, TASK-09, PRIV-01): the fixture-vault command the owner
 * runs for the live checks. Determinism, shape, the live-check notes, the safety
 * refusals, the help text, and the tracer: the real service serving a generated vault
 * correctly with no rebuild.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts", "generate-task-fixture-vault.mjs");
const DIST = join(REPO_ROOT, "packages", "test-fixtures", "dist", "task-fixtures.js");
const CLOCK = "2026-10-08T09:00:00Z";

const roots: string[] = [];
function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ccc-fixture-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function generate(
  count: number,
  extra: string[] = [],
  seed = "7",
): { out: string; status: number | null } {
  const out = join(freshRoot(), "vault");
  const result = run([
    "--out",
    out,
    "--count",
    String(count),
    "--seed",
    seed,
    "--clock",
    CLOCK,
    "--zone",
    "UTC",
    ...extra,
  ]);
  return { out, status: result.status };
}

/** The oracle: every task note on disk, parsed independently of the service. */
function tasksOnDisk(vaultRoot: string): { tasks: GeneratedTask[]; unreadable: string[] } {
  const tasks: GeneratedTask[] = [];
  const unreadable: string[] = [];
  const folders = ["global/tasks"];
  const workspaces = join(vaultRoot, "workspaces");
  if (existsSync(workspaces)) {
    for (const entry of readdirSync(workspaces)) folders.push(`workspaces/${entry}/tasks`);
  }
  for (const folder of folders) {
    const absolute = join(vaultRoot, ...folder.split("/"));
    if (!existsSync(absolute)) continue;
    for (const name of readdirSync(absolute)) {
      if (!name.endsWith(".md") || name === "index.md") continue;
      const path = `${folder}/${name}`;
      try {
        const { frontmatter: fm } = parseTaskNote(readFileSync(join(absolute, name), "utf8"));
        tasks.push({
          id: fm.id,
          path,
          scope: fm.scope,
          kind: "undated",
          status: fm.status,
          title: fm.title,
          ...(fm.due === undefined ? {} : { due: fm.due }),
          ...(fm.scheduled === undefined ? {} : { scheduled: fm.scheduled }),
          ...(fm.projectId === undefined ? {} : { projectId: fm.projectId }),
          dependencies: fm.dependencies,
        });
      } catch {
        unreadable.push(path);
      }
    }
  }
  return { tasks, unreadable };
}

/**
 * Task note files keyed by path, with the workspace ids (minted by the vault-repo, not
 * seeded) replaced by their position, so two runs can be compared byte for byte
 * everywhere the generator itself decides the content.
 */
function normalisedTaskFiles(vaultRoot: string): Record<string, string> {
  const ids = existsSync(join(vaultRoot, "workspaces"))
    ? readdirSync(join(vaultRoot, "workspaces"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];
  const normalise = (text: string): string =>
    ids.reduce((acc, id, index) => acc.split(id).join(`W${index + 1}`), text);
  const out: Record<string, string> = {};
  for (const [file] of Object.entries(hashVaultFiles(vaultRoot))) {
    if (!file.includes("/tasks/") || file.endsWith("/index.md")) continue;
    out[normalise(file)] = normalise(readFileSync(join(vaultRoot, ...file.split("/")), "utf8"));
  }
  return out;
}

describe("determinism (Test 1)", () => {
  it("gives identical task notes for the same inputs and different ones for another seed or count", () => {
    const a = generate(60);
    const b = generate(60);
    const c = generate(60, [], "8");
    const d = generate(80);
    expect([a.status, b.status, c.status, d.status]).toEqual([0, 0, 0, 0]);
    const filesA = normalisedTaskFiles(a.out);
    expect(normalisedTaskFiles(b.out)).toEqual(filesA);
    expect(normalisedTaskFiles(c.out)).not.toEqual(filesA);
    const filesD = normalisedTaskFiles(d.out);
    expect(Object.keys(filesD).length).toBeGreaterThan(Object.keys(filesA).length);
    // The notes shared by both counts are identical; only the extra notes and the creation stamps differ.
    const shared = Object.keys(filesA).filter((file) => file in filesD);
    expect(shared.length).toBeGreaterThan(40);
    // Creation stamps count back from the end of the run, so they move with the count; nothing else does.
    const unstamped = (text: string | undefined): string | undefined =>
      text?.replace(/^(created|updated): .*$/gm, "");
    for (const file of shared)
      expect(unstamped(filesD[file]), file).toEqual(unstamped(filesA[file]));
  });
});

describe("shape (Test 2)", () => {
  it("makes 300 valid notes with every view populated", () => {
    const { out, status } = generate(300);
    expect(status).toBe(0);
    const { tasks, unreadable } = tasksOnDisk(out);
    expect(unreadable).toEqual([]);
    expect(tasks).toHaveLength(300);
    expect(new Set(tasks.map((task) => task.scope)).size).toBe(3);
    const day = utcDay(new Date(CLOCK));
    const counts = expectedCounts(tasks, "all", day).counts;
    expect(counts.today).toBeGreaterThanOrEqual(10);
    expect(counts.overdue).toBeGreaterThanOrEqual(10);
    expect(counts.upcoming).toBeGreaterThanOrEqual(10);
    expect(counts.blocked).toBeGreaterThanOrEqual(5);
    expect(counts.completed).toBeGreaterThan(0);
    expect(tasks.some((task) => task.status === "cancelled")).toBe(true);
    const ids = new Set(tasks.map((task) => task.id));
    expect(tasks.some((task) => task.dependencies.some((id) => !ids.has(id)))).toBe(true);
  });
});

describe("live-check notes (Test 3)", () => {
  it("writes exactly the opt-in set, and nothing of it without the option", () => {
    const plain = generate(40);
    const live = generate(40, ["--live-check"]);
    expect(tasksOnDisk(plain.out).unreadable).toEqual([]);
    const withLive = tasksOnDisk(live.out);
    expect(withLive.unreadable.sort()).toEqual([
      "global/tasks/live-check-oversize-frontmatter.md",
      "global/tasks/live-check-unparseable.md",
    ]);
    const live3 = withLive.tasks.filter(
      (task) => task.title.startsWith("Live check") || task.status === "proposed",
    );
    expect(withLive.tasks.length - tasksOnDisk(plain.out).tasks.length).toBe(4);
    expect(live3.filter((task) => task.status === "proposed").length).toBeGreaterThanOrEqual(3);

    const properties = withLive.tasks.find(
      (task) => task.title === "Live check properties style date",
    );
    expect(properties?.due).toBe(utcDay(new Date(CLOCK)).localDate);
    const text = readFileSync(
      join(live.out, ...(properties as GeneratedTask).path.split("/")),
      "utf8",
    );
    expect(text).toMatch(new RegExp(`^due: ${properties?.due}$`, "m"));
    const sourced = readdirSync(join(live.out, "global", "tasks")).find((name) =>
      name.includes("source"),
    );
    expect(readFileSync(join(live.out, "global", "tasks", sourced as string), "utf8")).toContain(
      "sourceLink:",
    );
    expect(existsSync(join(plain.out, "global", "tasks", "live-check-unparseable.md"))).toBe(false);
  });
});

describe("safety (Test 4)", () => {
  const refused = (args: string[]): void => {
    const result = run(args);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^generate-task-fixture-vault: refused \(--?[a-z]+\)\n$/);
  };

  it("refuses unsafe output paths and writes nothing", () => {
    refused(["--out", join(REPO_ROOT, "scratch-fixture-vault")]);
    expect(existsSync(join(REPO_ROOT, "scratch-fixture-vault"))).toBe(false);
    const nonEmpty = freshRoot();
    writeFileSync(join(nonEmpty, "keep.txt"), "x");
    refused(["--out", nonEmpty]);
    expect(readdirSync(nonEmpty)).toEqual(["keep.txt"]);
    const file = join(freshRoot(), "a-file");
    writeFileSync(file, "x");
    refused(["--out", file]);
    refused(["--out", homedir()]);
    refused([]);
    const insideVault = freshRoot();
    mkdirSync(join(insideVault, ".obsidian"));
    refused(["--out", join(insideVault, "nested")]);
  });

  it("refuses malformed numbers, seeds and clocks before touching the file system", () => {
    const out = join(freshRoot(), "never");
    for (const bad of [
      ["--count", "0"],
      ["--count", "50001"],
      ["--count", "1.5"],
      ["--count", "x"],
    ]) {
      refused(["--out", out, ...bad]);
    }
    refused(["--out", out, "--seed", "abc"]);
    refused(["--out", out, "--clock", "yesterday"]);
    refused(["--out", out, "--zone", "Not/AZone"]);
    expect(existsSync(out)).toBe(false);
  });
});

describe("help (Test 5)", () => {
  it("lists every flag in one fixed order", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    const flags = [...result.stdout.matchAll(/^ {2}(--[a-z-]+)/gm)].map((match) => match[1]);
    expect(flags).toEqual([
      "--out",
      "--count",
      "--seed",
      "--clock",
      "--zone",
      "--live-check",
      "--help",
    ]);
  });
});

describe("missing build (Test 7)", () => {
  it("fails loudly naming the build step", () => {
    const hidden = `${DIST}.hidden`;
    renameSync(DIST, hidden);
    try {
      const result = run(["--out", join(freshRoot(), "vault")]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("pnpm exec turbo run build");
    } finally {
      renameSync(hidden, DIST);
    }
  });
});

describe("tracer: the real service serves a generated vault (Test 6)", () => {
  let account: string;
  const started: TestServiceHandle[] = [];
  beforeEach(() => {
    account = setUpServiceEnvironment();
  });
  afterEach(async () => {
    for (const service of started.splice(0)) await service.kill();
    tearDownServiceEnvironment(account);
  });

  async function start(dir: string, socketPath: string): Promise<{ token: string }> {
    mkdirSync(join(dir, "claude", "projects"), { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
    const service = await startServiceForTest({ socketPath, dbPath: join(dir, "operational.db") });
    started.push(service);
    return { token: await handshake(socketPath) };
  }

  it("answers counts, lists, proposed and attention with no rebuild call", async () => {
    const out = join(freshRoot(), "vault");
    const made = run([
      "--out",
      out,
      "--count",
      "400",
      "--seed",
      "11",
      "--zone",
      "UTC",
      "--live-check",
    ]);
    expect(made.status).toBe(0);
    const { tasks, unreadable } = tasksOnDisk(out);
    expect(tasks).toHaveLength(404);

    await withTempSocketDir(async ({ dir, socketPath }) => {
      const first = await start(dir, socketPath);
      const setup = await authedRequest<unknown>(socketPath, first.token, {
        method: "POST",
        path: VAULT_SETUP_PATH,
        body: { vaultRoot: out },
      });
      expect(setup.status).toBe(200);
      await (started.pop() as TestServiceHandle).stop();
      const { token } = await start(dir, socketPath);
      const day = utcDay(new Date());

      const counts = await authedRequest<TaskCountsResponse>(socketPath, token, {
        method: "POST",
        path: TASK_COUNTS_PATH,
        body: { context: { scope: "all" }, zone: "UTC" },
      });
      expect(counts.body).toEqual(expectedCounts(tasks, "all", day));

      for (const filter of [
        "today",
        "overdue",
        "upcoming",
        "proposed",
        "blocked",
        "completed",
      ] as TaskFilter[]) {
        const ids: string[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 50; page += 1) {
          const res = await authedRequest<TaskListResponse>(socketPath, token, {
            method: "POST",
            path: TASK_LIST_PATH,
            body: {
              context: { scope: "all" },
              filter,
              zone: "UTC",
              ...(cursor === undefined ? {} : { cursor }),
            },
          });
          ids.push(...res.body.rows.map((row) => row.id));
          if (res.body.nextCursor === null) break;
          cursor = res.body.nextCursor;
        }
        expect(new Set(ids), filter).toEqual(new Set(expectedIds(tasks, filter, "all", day)));
      }
      const proposed = tasks.filter(
        (task) => task.status === "proposed" && task.title.startsWith("Live check"),
      );
      expect(proposed.length).toBeGreaterThanOrEqual(2);

      const attention = await authedRequest<TaskAttentionResponse>(socketPath, token, {
        method: "POST",
        path: TASK_ATTENTION_PATH,
        body: {},
      });
      expect(attention.body.items.map((item) => item.path).sort()).toEqual([...unreadable].sort());
    });
  }, 120_000);
});
