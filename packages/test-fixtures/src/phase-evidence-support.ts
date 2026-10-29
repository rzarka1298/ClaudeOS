import { execFileSync } from "node:child_process";
import { REPO_ROOT } from "./gate-repo.js";

/**
 * Test support for the planning-record checks (`phase-evidence-09.test.ts`): table cells, quoted
 * citations, the test titles a vitest file would really run, and commit lookups. Reads text and git
 * only; it never runs anything it parses. The same parsing `phase-evidence-08.test.ts` does inline.
 */

export interface Cite {
  readonly file: string;
  readonly quote: string;
}

const CITE = /`([^`]+)`\s+"([^"]+)"/g;

/** The `file` "quoted title" pairs in a table cell. */
export function citesOf(cell: string): Cite[] {
  return [...cell.matchAll(CITE)].map((m) => ({ file: m[1] as string, quote: m[2] as string }));
}

/** The cells of one markdown table line (an escaped bar stays inside its cell). */
export function cellsOf(line: string): string[] {
  return line.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

/** The text between a level-2 heading and the next level-2 heading. */
export function section(source: string, heading: string): string {
  const match = new RegExp(`^## ${heading}$`, "m").exec(source);
  if (match === null) return "";
  const rest = source.slice(match.index + match[0].length);
  return rest.split(/^## /m)[0] as string;
}

/**
 * The titles a test file declares, as vitest would run them. A title counts when it is the first
 * argument of a `describe`, `it` or `test` call (or the `run` alias this folder uses for a
 * conditional describe) that is not skipped, nor inside a skipped describe. A describe counts only
 * when it holds at least one such live `it` or `test`. Text in a comment, a string that is not a
 * call's title and a template title are never matched.
 */
export function liveTitles(source: string): Set<string> {
  const calls: {
    kind: "suite" | "case";
    title: string;
    skipped: boolean;
    start: number;
    end: number;
  }[] = [];
  // A call whose title is a string or a template, and a test call whose title is computed (a case
  // made in a loop): the second kind has no title to cite but is a live case all the same.
  const pattern =
    /(?<![.\w$])(describe|it|test|run)((?:\.\w+)*)\s*(?:\([^()]*\))?\s*\(\s*(["'`])((?:\\.|(?!\3)[^\\\n])*)\3/g;
  const computed = /(?<![.\w$])(it|test)((?:\.\w+)*)\s*(?:\([^()]*\))?\s*\(\s*(?=[A-Za-z_$])/g;
  const matches = [
    ...[...source.matchAll(pattern)].map((match) => ({ match, title: match[4] ?? "" })),
    ...[...source.matchAll(computed)].map((match) => ({ match, title: "\u0000computed" })),
  ];
  for (const { match, title } of matches) {
    const start = match.index ?? 0;
    // Skip a match inside a line comment, or inside a string literal that began earlier on its line.
    const lineStart = source.lastIndexOf("\n", start) + 1;
    const before = source.slice(lineStart, start);
    if (/^\s*(\/\/|\*|\/\*)/.test(before)) continue;
    const quotes = (mark: string): number => before.replace(/\\./g, "").split(mark).length - 1;
    if (quotes('"') % 2 === 1 || quotes("'") % 2 === 1) continue;
    const suite = match[1] === "describe" || match[1] === "run";
    // A suite runs from its own line to the next suite at the same or a shallower indentation (or
    // the end of the file). Indentation, not braces: regular expressions and strings in a body hold
    // quotes and braces that a light scan cannot tell from code.
    let end = source.length;
    if (suite) {
      const indent = (/^[ \t]*/.exec(source.slice(lineStart))?.[0] ?? "").length;
      const next = [
        ...source.matchAll(/^([ \t]*)(?:describe|run)(?:\.\w+)*\s*(?:\([^()]*\))?\s*\(/gm),
      ].find(
        (candidate) => (candidate.index ?? 0) > start && (candidate[1] ?? "").length <= indent,
      );
      end = next?.index ?? source.length;
    }
    calls.push({
      kind: suite ? "suite" : "case",
      title: title.replace(/\\(["'`\\])/g, "$1"),
      skipped: /\.(skip|todo)\b/.test(match[2] ?? ""),
      start,
      end,
    });
  }
  const live = (call: (typeof calls)[number]): boolean =>
    !call.skipped &&
    !calls.some(
      (other) =>
        other.kind === "suite" &&
        other.skipped &&
        other.start < call.start &&
        call.start < other.end,
    );
  const titles = new Set<string>();
  for (const call of calls) {
    if (!live(call)) continue;
    if (call.kind === "case") titles.add(call.title);
    else if (
      calls.some(
        (inner) =>
          inner.kind === "case" &&
          live(inner) &&
          inner.start > call.start &&
          inner.start < call.end,
      )
    ) {
      titles.add(call.title);
    }
  }
  return titles;
}

/** True when this cite is proved by a vitest file. */
export const isTestFile = (file: string): boolean => /\.test\.tsx?$/.test(file);

function git(args: readonly string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/** True when the hash names a commit that exists in this repository. */
export function commitExists(hash: string): boolean {
  return git(["cat-file", "-t", hash]) === "commit";
}

/** True when the commit is part of the checked-out history (a merge keeps the cited commits). */
export function reachableFromHead(hash: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", hash, "HEAD"], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/** True when the path is byte-identical in the two commits. */
export function unchangedBetween(from: string, to: string, path: string): boolean {
  return git(["diff", "--name-only", from, to, "--", path]) === "";
}

/** The paths a commit touched. */
export function filesOfCommit(hash: string): string[] {
  const out = git(["show", "--name-only", "--format=", hash]);
  return out === undefined ? [] : out.split("\n").filter(Boolean);
}
