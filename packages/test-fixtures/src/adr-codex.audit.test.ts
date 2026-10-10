// Plan 05.1-30: the published architecture and owner acceptance contract.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const phase = ".planning/phases/05.1-codex-co-work-usage";
const hasPlanning = existsSync(join(root, phase, "05.1-RECONCILE.md"));
const planningDescribe = hasPlanning ? describe : describe.skip;
const adrPath = "docs/adr/0028-codex-data-sources-version-gating-and-usage.md";
function read(path: string): string {
  const file = join(root, path);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}
function frontmatter(text: string): string {
  return text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
}
function privateFindings(text: string): string[] {
  const findings: string[] = [];
  for (const match of text.matchAll(/\/Users\/([A-Za-z0-9._$<>-]+)\/?/g)) {
    if (!["USERNAME", "username", "<username>", "$USER", "you"].includes(match[1] ?? "")) {
      findings.push("home path");
    }
  }
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text)) findings.push("email");
  if (/(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})/.test(text)) {
    findings.push("secret-shaped literal");
  }
  if (
    /(?:agents? (?:may|should|must) (?:read|open)|read the owner's) (?:Codex )?(?:credential|configuration)/i.test(
      text,
    )
  ) {
    findings.push("instruction to read private configuration");
  }
  return findings;
}

describe("ADR-13 Codex architecture contract (task 1)", () => {
  it("publishes ADR 0028 with its accepted requirement and reciprocal partial supersession", () => {
    if (hasPlanning) expect(read(`${phase}/05.1-RECONCILE.md`)).toContain("**0028**");
    expect(readdirSync(join(root, "docs/adr")).filter((name) => name.startsWith("0028-"))).toEqual([
      "0028-codex-data-sources-version-gating-and-usage.md",
    ]);
    const adr = read(adrPath);
    expect(frontmatter(adr)).toMatch(/^status: accepted$/m);
    expect(frontmatter(adr)).toMatch(/^satisfies: ADR-13$/m);
    expect(frontmatter(adr)).toMatch(/^supersedes-in-part: 0024$/m);
    expect(adr).toMatch(/^# Codex data is read through allowlisted ports/m);
    const previous = read("docs/adr/0024-launchers-and-project-actions.md");
    expect(frontmatter(previous)).toMatch(/^superseded-in-part-by: 0028$/m);
    expect(previous).toMatch(/^> 2026-10-10: Superseded in part by ADR-0028/m);
  });

  it("records decisions, reasons, rejected alternatives, evidence and the four owner confirmations", () => {
    const adr = read(adrPath);
    for (const heading of [
      "Context",
      "Decision",
      "Alternatives rejected",
      "Consequences",
      "Verification and open items",
    ]) {
      expect(adr).toContain(`## ${heading}`);
    }
    for (const phrase of [
      "allowlisted CODEX_HOME port",
      "read-only",
      "shape-based version gate",
      "recognition ratio",
      "last lifecycle event in file order",
      "inactivity window",
      "never inferred completed",
      "optional fail-open hook package",
      "notify slot is never taken",
      "account/rateLimits/read",
      "account identifier is discarded",
      "80 percent",
      "read-only headroom signal",
      "latest cumulative value per thread and turn",
      "parser v3",
      "shared transcript-analysis gate",
      "protocol version 2",
      "bridge-not-installed",
      "bridge-outdated",
      "window-not-ready",
      "backstop rule 16",
      "negative control",
      "migration 0009",
      "rollout fallback is not implemented",
      "A10",
      "token counting unit",
      "default Codex arguments",
      "saved Antigravity bundle",
      "Verified on the owner's machine",
      "Owner UAT",
      "D-05",
      "D-16",
      "D-18",
      "D-21",
      "D-22",
      "D-24",
      "D-26",
    ])
      expect(adr.replace(/\s+/g, " ").toLowerCase(), `missing decision: ${phrase}`).toContain(
        phrase.toLowerCase(),
      );
  });

  it("keeps the ADR and back-link free of private paths, emails, secrets and unsafe instructions", () => {
    for (const path of [
      adrPath,
      "docs/adr/0024-launchers-and-project-actions.md",
      `${phase}/05.1-30-task1-red-evidence.json`,
      `${phase}/05.1-30-task2-red-evidence.json`,
      `${phase}/05.1-30-task3-red-evidence.json`,
      `${phase}/05.1-30-SUMMARY.md`,
    ]) {
      expect(privateFindings(read(path)), path).toEqual([]);
    }
  });

  it("the privacy audit distinguishes placeholders from every prohibited category", () => {
    expect(privateFindings("/Users/USERNAME/repo")).toEqual([]);
    expect(privateFindings(["", "Users", "audit-owner"].join("/"))).toEqual(["home path"]);
    expect(privateFindings(["private", "invalid.test"].join("@"))).toEqual(["email"]);
    expect(privateFindings(["sk-", "a".repeat(24)].join(""))).toEqual(["secret-shaped literal"]);
    expect(privateFindings("Agents may read Codex configuration")).toEqual([
      "instruction to read private configuration",
    ]);
  });
});

const uatSubjects = [
  ["warm", "Claude first", "500 ms", "5 s"],
  ["cold", "Antigravity is still starting.", "late tabs"],
  ["two windows", "folder"],
  ["focused", "focus theft"],
  ["XDG_STATE_HOME", "Dock"],
  ["0.1.0", "bridge-outdated"],
  ["bridge absent", "Terminal.app"],
  ["Codex missing", "Claude", "Check Codex health"],
  ["app-server", "minimal", "codex-bridge usage", "Weekly window · 10,080 min"],
  ["/hooks", "10 s", "latency", "TUI", "installed-no-events"],
  ["warning", "every open", "Follow live log", "cold-start"],
  ["attribution", "unknown", "limit-paused"],
  ["Delete cached usage analytics", "counters", "dedup"],
  ["keyboard", "reduced motion", "200%", "Settings"],
  ["saved Terminal.app", "untouched"],
  ["saved Antigravity bundle", "com.google.antigravity-ide"],
];

planningDescribe("Phase 05.1 owner acceptance contract (task 3)", () => {
  it("keeps U1 through U16 in order, pending, tagged and actionable for the owner", () => {
    const uat = read(`${phase}/05.1-UAT.md`);
    expect(uat).toMatch(/^Status: NOT RUN/m);
    const blocks = [
      ...uat.matchAll(/^### U(\d+) — ([^\n]+)\n([\s\S]*?)(?=^### U\d+ — |^## |$(?![\s\S]))/gm),
    ];
    expect(blocks.map((block) => Number(block[1]))).toEqual(
      Array.from({ length: 16 }, (_, i) => i + 1),
    );
    for (const [index, block] of blocks.entries()) {
      const title = block[2] ?? "";
      const body = block[3] ?? "";
      expect(title).toMatch(/CODEX-\d+/);
      for (const field of ["Preconditions:", "Steps:", "Expected:", "Record:", "result: [pending]"])
        expect(body).toContain(field);
      expect(body).toMatch(/^tag: (auto|owner)$/m);
      expect(body).toMatch(/^run: (auto|auto\+look|owner)$/m);
      if (/^run: owner$/m.test(body)) expect(body).toMatch(/^owner-why: .+/m);
      expect(body).toMatch(/^1\. /m);
      expect(body).toMatch(/^2\. /m);
      for (const subject of uatSubjects[index] ?? [])
        expect(`${title} ${body}`.replace(/\s+/g, " ").toLowerCase()).toContain(
          subject.toLowerCase(),
        );
    }
    expect(uat).toContain("## Results");
    expect(uat.match(/^result: \[pending\]$/gm)).toHaveLength(16);
    expect(uat).not.toMatch(/^result: (?:pass|fail)/im);
  });

  it("isolates runtime, Keychain, vault and upstream homes with honest setup and teardown", () => {
    const uat = read(`${phase}/05.1-UAT.md`).replace(/\s+/g, " ");
    for (const phrase of [
      "Agents never run this script",
      "never read or install into the owner's real Codex home, configuration or bridge state",
      "configuration facts as counts only",
      "mktemp -d /tmp/ccc-uat.XXXXXX",
      "chmod 700",
      "CCC_RUNTIME_DIR",
      "CCC_INSTALL_SECRET_ACCOUNT",
      "ccc-uat-",
      "node packages/service/dist/main.js",
      "packages/service/src/auth/install-secret.ts",
      "copy the plugin",
      "never link",
      "Dry run: nothing was written.",
      "--no-extension",
      "--home",
      "## Teardown",
      "byte-exact",
      "security delete-generic-password -a",
      "-s com.claude-command-center",
      "launchd label",
    ])
      expect(uat).toContain(phrase);
    expect(privateFindings(uat)).toEqual([]);
  });

  it("records owner decisions with defaults, dependent plans and the single baseline commit", () => {
    const uat = read(`${phase}/05.1-UAT.md`);
    const decisions = uat.split("## Owner decisions")[1] ?? "";
    for (const phrase of [
      "A10",
      "direct gestures",
      "token counting unit",
      "empty",
      "saved Antigravity bundle",
      "Antigravity terminal",
      "Check Codex health",
      "n of 3 launchers set up",
      "Detect again",
      "Detect apps",
      "single baseline commit",
      "47",
      "Phase 6",
      "05.1-02",
      "05.1-23",
      "05.1-21",
      "05.1-13",
      "05.1-31",
      "05.1-27",
    ])
      expect(decisions.replace(/\s+/g, " ")).toContain(phrase);
  });
});

const order =
  "Phases merge in this order (phase numbering retained): 1 → 2 → 3 → 4 → 5 → 6 → 05.1 → 7 → 8";
const glossaryTerms = [
  "Antigravity terminal",
  "Pair launch",
  "Headroom",
  "Reserve",
  "Codex session",
];
planningDescribe("Phase 05.1 planning contract (task 2)", () => {
  it("lists every actual plan in order with wave, objective, count and the merged execution order", () => {
    const roadmap = read(".planning/ROADMAP.md");
    const block = roadmap.split("### Phase 05.1:")[1]?.split("### Phase 6:")[0] ?? "";
    const plans = readdirSync(join(root, phase))
      .filter((name) => /^05\.1-\d+-PLAN\.md$/.test(name))
      .sort();
    const entries = [...block.matchAll(/^- \[ \] (05\.1-\d+-PLAN\.md) \[wave (\d+)\] — (.+)$/gm)];
    expect(entries.map((entry) => entry[1])).toEqual(plans);
    for (const entry of entries) {
      expect(frontmatter(read(`${phase}/${entry[1]}`))).toContain(`wave: ${entry[2]}`);
      expect(entry[3]?.trim().length).toBeGreaterThan(10);
    }
    expect(block).toContain(`**Plans**: ${plans.length} plans, 8 waves`);
    expect(block).not.toContain("**Plans**: TBD");
    expect(roadmap).toContain(
      `| 05.1. Codex Co-Work & Usage (INSERTED) | 0/${plans.length} | Not started | - |`,
    );
    expect(roadmap).toContain(order);
    expect(roadmap).toContain(
      "Phase 6 merged first; Phase 05.1 was planned and merges against that merged tree.",
    );
  });

  it("records the dated default without rewriting saved choices and adds only the five glossary terms", () => {
    const project = read(".planning/PROJECT.md");
    const rows = project
      .split("\n")
      .filter((line) => line.startsWith("| The Antigravity terminal"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("Terminal.app is the fallback adapter");
    expect(rows[0]).toContain("Detection only proposes; a saved choice is never rewritten");
    expect(rows[0]).toContain("2026-10-04");
    for (const term of glossaryTerms) expect(read("CONTEXT.md")).toContain(`**${term}**:`);
  });

  it("keeps agent bridge restrictions and reserve while recording merged review and product launch facts", () => {
    const workflow = read(".planning/WORKFLOW.md");
    for (const phrase of [
      "Raw `codex` is denied to agents",
      "20 % reserve",
      "≥80 %",
      "standalone 0.159.2, bundled 0.160.0",
      "blocking judge from Phase 05.1",
      "product pair launch uses the same Antigravity request/claim mechanism",
      "optional Codex hook",
      "notify slot",
      "account/rateLimits/read",
    ]) {
      expect(workflow.replace(/\s+/g, " ")).toContain(phrase);
    }
  });

  it("preserves all existing PROJECT rows, glossary entries and unrelated ROADMAP sections", () => {
    const project = read(".planning/PROJECT.md")
      .split("\n")
      .filter((line) => !line.startsWith("| The Antigravity terminal"))
      .join("\n");
    expect(createHash("sha256").update(project).digest("hex")).toBe(
      "58debbc453883df848bbb45fd66f923e06eec8bdc4ae40f20d05d71e30a0c0f1",
    );
    const glossary = read("CONTEXT.md").replace(
      /\*\*Antigravity terminal\*\*:[\s\S]*?(?=### Knowledge)/,
      "",
    );
    expect(createHash("sha256").update(glossary).digest("hex")).toBe(
      "b9f4a399811cb78ca935086df0cf7bb05a1faf3de924ae64a7b29d2faeb8e81b",
    );
    const roadmap = read(".planning/ROADMAP.md");
    expect(roadmap.match(/\| ADR-13 \|.*$/m)?.[0]).toBe(
      "| ADR-13 | Codex data sources, version gating and event normalization | 05.1 | Consumed by the Codex collectors and the usage/headroom read; inserted with the owner-approved Codex phase |",
    );
    expect(
      createHash("sha256")
        .update(roadmap.split("### Phase 6:")[1]?.split("### Phase 7:")[0] ?? "")
        .digest("hex"),
    ).toBe("0dae3a2bbc1a388ba306f670dd3180fc95058f4a22f3d04b01af34a0ad936ff5");
  });

  it("preserves all text outside the reconciled planning edits and ADR back-link", () => {
    const previous = read("docs/adr/0024-launchers-and-project-actions.md")
      .replace(/^superseded-in-part-by: 0028\n/m, "")
      .replace(/^> 2026-10-10: Superseded in part by ADR-0028[^\n]*\n\n/m, "");
    expect(createHash("sha256").update(previous).digest("hex")).toBe(
      "bb6424d311e3e75a2ae6ea740b1aecd2154faf66710977cbe1fa28d53d76b5d0",
    );
    let roadmapRemainder = read(".planning/ROADMAP.md");
    roadmapRemainder = roadmapRemainder.replace(
      /\*\*Plans\*\*: [^\n]+(?:\n\n- \[ \].*?(?=\n\*\*UI hint\*\*))?/gms,
      "PLAN-LIST",
    );
    roadmapRemainder = roadmapRemainder.replace(
      /Phase 05\.1 \(Codex Co-Work & Usage, inserted 2026-09-30\)[\s\S]*?(?=\n\n## ADR Placement)/gm,
      "ORDER-NOTE",
    );
    roadmapRemainder = roadmapRemainder.replace(/Phases (?:execute|merge) [^\n]+/gm, "MERGE-ORDER");
    roadmapRemainder = roadmapRemainder.replace(
      /\| 05\.1\. Codex Co-Work & Usage \(INSERTED\).*/gm,
      "PROGRESS",
    );
    expect(createHash("sha256").update(roadmapRemainder).digest("hex")).toBe(
      "fc3af9688edc48e1a9458fee3db39f9178770200b9c2c6174c1174dc96f081cb",
    );
    let workflowRemainder = read(".planning/WORKFLOW.md");
    workflowRemainder = workflowRemainder.replace(
      /^- \*\*Roles → models\*\*[^\n]+/gm,
      "MODEL-VERSIONS",
    );
    workflowRemainder = workflowRemainder.replace(
      /^- \*\*(?:Review is advisory|Phase 6 has merged)[\s\S]*?(?=^- \*\*Tasks)/gm,
      "REVIEW",
    );
    workflowRemainder = workflowRemainder.replace(
      /^ {2}- The product pair launch[\s\S]*?(?=^ {2}- \*Project\*)/gm,
      "",
    );
    expect(createHash("sha256").update(workflowRemainder).digest("hex")).toBe(
      "80b9052ad71c537e526f15c53e6500a351e033be1c27f11ec63ded9a8ebdd0c1",
    );
  });

  it("keeps every planning edit private-data-free", () => {
    for (const path of [
      ".planning/ROADMAP.md",
      ".planning/PROJECT.md",
      ".planning/WORKFLOW.md",
      "CONTEXT.md",
    ])
      expect(privateFindings(read(path)), path).toEqual([]);
  });
});
