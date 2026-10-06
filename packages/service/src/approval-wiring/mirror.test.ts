import {
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
import {
  APPROVAL_STATE_DISPLAY,
  type ApprovalLog,
  HOSTILE_CORPUS,
  type NoteId,
  type ProposalId,
  type ProposalState,
  type StoredProposal,
} from "@ccc/domain";
import { initializeVault, parseNote } from "@ccc/vault-repo";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApprovalMirror } from "./mirror.js";

/**
 * The read-only vault mirror note (plan 06-13, task 3, D-22, T-06-16). Every
 * fixture is synthetic. The note is written from engine-templated text only, so
 * the hostile corpus must never appear in it.
 */

const PROPOSAL = "0mfk1a2b3c4d5e6f7a8b9c001" as ProposalId;
const NOTE_ID = "0abcdefghij0123456789abcd" as NoteId;
const CREATED = "2026-10-06T10:00:00.000Z";
const EXPIRES = "2026-10-06T15:20:00.000Z";

function stored(overrides: Partial<StoredProposal> = {}): StoredProposal {
  return {
    proposalId: PROPOSAL,
    operation: "session.force-terminate",
    subject: "session-subject",
    dedupeKey: "key",
    requester: { kind: "dashboard", label: "Dashboard" },
    projectId: null,
    runId: null,
    reason: "The session stopped responding.",
    payloadJson: "{}",
    payloadHash: "ab12".repeat(16),
    state: "pending",
    revision: 1,
    createdAt: CREATED,
    expiresAt: EXPIRES,
    approvedAt: null,
    decidedAt: null,
    decidedVia: null,
    claimFacts: null,
    attempts: 0,
    outcomeCode: null,
    outcomeNote: null,
    mirrorNoteId: NOTE_ID,
    supersedes: null,
    ...overrides,
  };
}

function recordingLog() {
  const lines: { level: string; fields: Readonly<Record<string, unknown>> }[] = [];
  const log: ApprovalLog = {
    info: (fields) => lines.push({ level: "info", fields }),
    warn: (fields) => lines.push({ level: "warn", fields }),
    error: (fields) => lines.push({ level: "error", fields }),
  };
  return { log, lines };
}

let base: string;
let vaultRoot: string;

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "ccc-mirror-")));
  vaultRoot = join(base, "Example Vault");
  mkdirSync(vaultRoot);
  initializeVault(vaultRoot);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function mirrorNotes(): string[] {
  return readdirSync(join(vaultRoot, "system")).filter(
    (f) => f.endsWith(".md") && f !== "index.md",
  );
}

function readMirror(noteId: string = NOTE_ID): string {
  return readFileSync(join(vaultRoot, "system", `${noteId}.md`), "utf8");
}

describe("content (test 1)", () => {
  it("writes exactly the UI-SPEC shape from engine data only", async () => {
    const { log } = recordingLog();
    const mirror = createApprovalMirror({ getVaultRoot: () => vaultRoot, log });
    await mirror.mirror(stored());
    const { body } = parseNote(readMirror());
    expect(body.trim()).toBe(
      [
        "> Mirror — decisions are made in the command center, not in this note. Editing it changes nothing.",
        "",
        "# Approval request: Force-terminate a Claude session",
        "",
        "- Status: Needs your decision",
        "- Requested by: Dashboard",
        "- Expires: Oct 6, 2026, 3:20 PM UTC",
        `- [Open in the command center](obsidian://ccc-approval?id=${PROPOSAL}&vault=Example%20Vault)`,
      ].join("\n"),
    );
  });

  it("uses the display label of every state", async () => {
    const { log } = recordingLog();
    const mirror = createApprovalMirror({ getVaultRoot: () => vaultRoot, log });
    for (const state of Object.keys(APPROVAL_STATE_DISPLAY) as ProposalState[]) {
      await mirror.mirror(stored({ state }));
      expect(parseNote(readMirror()).body).toContain(
        `- Status: ${APPROVAL_STATE_DISPLAY[state].label}\n`,
      );
    }
  });

  it("falls back to a generic heading for an unknown operation and shows the kind word only", async () => {
    const { log } = recordingLog();
    const mirror = createApprovalMirror({ getVaultRoot: () => vaultRoot, log });
    await mirror.mirror(
      stored({
        operation: "not.an.operation",
        requester: { kind: "automation", label: "Nightly" },
      }),
    );
    const { body } = parseNote(readMirror());
    expect(body).toContain("# Approval request: Unknown request");
    expect(body).toContain("- Requested by: Automation");
    expect(body).not.toContain("not.an.operation");
    expect(body).not.toContain("Nightly");
  });

  it("carries no always-allow or remembered-choice wording (APPR-05)", async () => {
    const { log } = recordingLog();
    const mirror = createApprovalMirror({ getVaultRoot: () => vaultRoot, log });
    for (const state of Object.keys(APPROVAL_STATE_DISPLAY) as ProposalState[]) {
      await mirror.mirror(stored({ state }));
      expect(readMirror()).not.toMatch(/always|remember|standing|auto-?approv|allow/i);
    }
  });
});

describe("nothing from the requester (test 2)", () => {
  it("never lets any hostile corpus entry, in any requester-influenced field, into the note", async () => {
    const { log } = recordingLog();
    const mirror = createApprovalMirror({ getVaultRoot: () => vaultRoot, log });
    for (const entry of HOSTILE_CORPUS) {
      const text = entry.text;
      await mirror.mirror(
        stored({
          requester: { kind: "skill", label: text },
          reason: text,
          subject: text,
          projectId: text,
          runId: text,
          payloadJson: JSON.stringify({ target: text, project: text, path: text }),
          outcomeNote: text,
          outcomeCode: "x",
        }),
      );
      const note = readMirror();
      expect(note, entry.name).not.toContain(text);
      // And the note holds no control or invisible character other than a line feed.
      expect(note.replace(/\n/g, ""), entry.name).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    }
  });

  it("keeps a run name, a project name, a target path and markup out of the note", async () => {
    const { log } = recordingLog();
    const mirror = createApprovalMirror({ getVaultRoot: () => vaultRoot, log });
    const lt = String.fromCharCode(0x3c);
    await mirror.mirror(
      stored({
        requester: { kind: "connector", label: `Evil ${lt}b${">"}label` },
        reason: "Refactor parser at /Users/USERNAME/example-project",
        payloadJson: JSON.stringify({
          runName: "Refactor parser",
          pid: 4242,
          path: "/Users/USERNAME/x",
        }),
        projectId: "example-project",
      }),
    );
    const note = readMirror();
    for (const word of ["Evil", "Refactor parser", "example-project", "/Users/", "4242", lt]) {
      expect(note).not.toContain(word);
    }
    expect(note).toContain("- Requested by: Connector");
  });
});

describe("link (test 3)", () => {
  it("encodes the vault folder name and never carries an absolute path", async () => {
    const odd = join(base, "My Vault+2 é");
    mkdirSync(odd);
    initializeVault(odd);
    const { log } = recordingLog();
    await createApprovalMirror({ getVaultRoot: () => odd, log }).mirror(stored());
    const note = readFileSync(join(odd, "system", `${NOTE_ID}.md`), "utf8");
    expect(note).toContain(
      `obsidian://ccc-approval?id=${PROPOSAL}&vault=${encodeURIComponent(basename(odd))}`,
    );
    expect(note).toContain("vault=My%20Vault%2B2%20%C3%A9)");
    expect(note).not.toContain(base);
    expect(note).not.toContain("/Users/");
    expect(note).not.toContain("/private/");
  });
});

describe("identity and update (test 4)", () => {
  it("uses the stored mirror note id, rewrites the same file and keeps the created time", async () => {
    const { log } = recordingLog();
    const mirror = createApprovalMirror({ getVaultRoot: () => vaultRoot, log });
    await mirror.mirror(stored());
    expect(mirrorNotes()).toEqual([`${NOTE_ID}.md`]);
    const first = parseNote(readMirror());
    expect(first.frontmatter.id).toBe(NOTE_ID);
    expect(first.frontmatter.created).toBe(CREATED);

    await mirror.mirror(
      stored({ state: "approved", revision: 2, decidedAt: "2026-10-06T11:00:00.000Z" }),
    );
    expect(mirrorNotes()).toEqual([`${NOTE_ID}.md`]);
    const second = parseNote(readMirror());
    expect(second.frontmatter.id).toBe(NOTE_ID);
    expect(second.frontmatter.created).toBe(CREATED);
    expect(second.body).toContain("- Status: Approved\n");
    expect(second.body).not.toContain("Needs your decision");
  });

  it("derives the file name from the mirror note id and from no text", async () => {
    const { log } = recordingLog();
    const mirror = createApprovalMirror({ getVaultRoot: () => vaultRoot, log });
    const otherId = "0zzzzzzzzz9876543210zyxwv" as NoteId;
    await mirror.mirror(
      stored({ mirrorNoteId: otherId, requester: { kind: "skill", label: "Quarterly report" } }),
    );
    expect(mirrorNotes()).toEqual([`${otherId}.md`]);
  });
});

describe("frontmatter (test 5)", () => {
  it("is a capture-stage, non-AI, approval-engine, global-scope note in the system folder", async () => {
    const { log } = recordingLog();
    await createApprovalMirror({ getVaultRoot: () => vaultRoot, log }).mirror(stored());
    const { frontmatter } = parseNote(readMirror());
    expect(frontmatter.stage).toBe("capture");
    expect(frontmatter.aiGenerated).toBe(false);
    expect(frontmatter.generatedBy).toEqual({ automation: "approval-engine" });
    expect(frontmatter.scope).toBe("global");
    expect(readdirSync(join(vaultRoot, "system"))).toContain(`${NOTE_ID}.md`);
  });
});

describe("best effort (test 6)", () => {
  it("writes nothing and logs nothing as an error when there is no vault root", async () => {
    const { log, lines } = recordingLog();
    await createApprovalMirror({ getVaultRoot: () => null, log }).mirror(stored());
    expect(mirrorNotes()).toEqual([]);
    expect(lines.filter((l) => l.level === "error")).toEqual([]);
  });

  it("swallows and logs once by class name when the vault root does not exist", async () => {
    const { log, lines } = recordingLog();
    const missing = join(base, "no-such-vault");
    await expect(
      createApprovalMirror({ getVaultRoot: () => missing, log }).mirror(stored()),
    ).resolves.toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0]?.fields ?? {})).toEqual(["errorName"]);
    expect(JSON.stringify(lines)).not.toContain(base);
  });

  it("swallows a scope violation, a throwing root lookup and a filesystem error", async () => {
    const hostileId = "../workspaces/x/escape" as NoteId;
    const violation = recordingLog();
    await expect(
      createApprovalMirror({ getVaultRoot: () => vaultRoot, log: violation.log }).mirror(
        stored({ mirrorNoteId: hostileId }),
      ),
    ).resolves.toBeUndefined();
    expect(violation.lines).toHaveLength(1);
    expect(violation.lines[0]?.fields).toEqual({ errorName: "WorkspaceScopeViolationError" });

    const throwing = recordingLog();
    await expect(
      createApprovalMirror({
        getVaultRoot: () => {
          throw new RangeError("root lookup failed /Users/USERNAME/secret");
        },
        log: throwing.log,
      }).mirror(stored()),
    ).resolves.toBeUndefined();
    expect(throwing.lines).toHaveLength(1);
    expect(throwing.lines[0]?.fields).toEqual({ errorName: "RangeError" });

    const notADirectory = join(base, "a-file");
    writeFileSync(notADirectory, "x");
    const fsError = recordingLog();
    await expect(
      createApprovalMirror({ getVaultRoot: () => notADirectory, log: fsError.log }).mirror(
        stored(),
      ),
    ).resolves.toBeUndefined();
    expect(fsError.lines).toHaveLength(1);
    expect(Object.keys(fsError.lines[0]?.fields ?? {})).toEqual(["errorName"]);
  });
});

describe("never read back (test 7)", () => {
  it("exports only the writer factory and imports no reader", async () => {
    const module = await import("./mirror.js");
    expect(Object.keys(module)).toEqual(["createApprovalMirror"]);
    const source = readFileSync(new URL("./mirror.ts", import.meta.url), "utf8");
    for (const reader of [
      "readFileSync",
      "readdirSync",
      "parseNote",
      "readFile(",
      "createReadStream",
    ]) {
      expect(source, reader).not.toContain(reader);
    }
  });
});

describe("volume (test 8)", () => {
  it("writes one hundred mirror notes and reports the cost per write", async () => {
    const { log, lines } = recordingLog();
    const mirror = createApprovalMirror({ getVaultRoot: () => vaultRoot, log });
    const start = performance.now();
    for (let i = 0; i < 100; i += 1) {
      const id = `0mirror${String(i).padStart(18, "0")}` as NoteId;
      await mirror.mirror(stored({ mirrorNoteId: id }));
    }
    const elapsedMs = performance.now() - start;
    expect(mirrorNotes()).toHaveLength(100);
    expect(lines).toEqual([]);
    // Recorded in the SUMMARY (T-06-33): the system folder's synchronous index is rebuilt per write.
    console.info(
      `mirror volume: 100 writes in ${elapsedMs.toFixed(0)} ms (${(elapsedMs / 100).toFixed(1)} ms per write)`,
    );
    expect(elapsedMs).toBeLessThan(60_000);
  });
});
