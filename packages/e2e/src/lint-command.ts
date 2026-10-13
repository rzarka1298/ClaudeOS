import { join } from "node:path";
import { SPEC_FILES, specsForProfile, UAT_ITEM_PLAN, UAT_PHASE_PREFIX } from "./spec-map.js";
import {
  checkMapAgainstScript,
  expectedTitlesByItem,
  extractSpecTitles,
  findOnlyTests,
  groupTitles,
  lintTags,
} from "./tag-lint.js";
import { parseUatScript, phasePrefixOf, type TagFinding } from "./uat-tags.js";
import { SCALE_SPEC } from "./wdio-config.js";

/**
 * The tag-lint command (05.2-09, D-09, E2E-04, E2E-06): the strict 1:1 between tagged script
 * items and spec titles, the classification table, the existence of every spec file the table
 * names and the profile rule that the 10,000-task spec stays out of the standard run. Output is a
 * finding code and an item number per line, never script or spec text.
 */

export interface LintCommandInput {
  scriptPath: string;
  specsDir: string;
  readFile: (path: string) => string | null;
  /** The file names directly inside a folder; empty when it does not exist. */
  listFiles: (dir: string) => string[];
  /** The spec files the standard profile runs; defaults to the table's standard list. */
  standardSpecs?: readonly string[];
}

export interface LintCommandResult {
  exitCode: 0 | 1;
  lines: string[];
}

const SPEC_PATH_PREFIX = "packages/e2e/specs/";

function format(found: readonly TagFinding[]): string[] {
  return found.map((entry) =>
    entry.item === null ? entry.code : `${entry.code} item ${entry.item}`,
  );
}

function fileName(specFile: string): string {
  return specFile.split("/").pop() ?? specFile;
}

export function lintTagsCommand(input: LintCommandInput): LintCommandResult {
  const script = input.readFile(input.scriptPath);
  if (script === null) return { exitCode: 1, lines: ["SCRIPT_UNREADABLE"] };

  const parsed = parseUatScript(script);
  const phasePrefix = phasePrefixOf(parsed.frontMatter) ?? UAT_PHASE_PREFIX;
  const present = new Set(
    input.listFiles(input.specsDir).filter((name) => name.endsWith(".e2e.ts")),
  );

  // Every spec file in the folder is a key (even with no titles) so a missing file is distinct
  // from an empty one; titles are keyed by the path the script's spec tag uses.
  const specTitles = new Map<string, string[]>();
  const titles = [];
  for (const name of present) {
    const key = `${SPEC_PATH_PREFIX}${name}`;
    specTitles.set(key, []);
    const source = input.readFile(join(input.specsDir, name)) ?? "";
    titles.push(...extractSpecTitles(key, source, phasePrefix));
  }
  for (const [key, list] of groupTitles(titles)) specTitles.set(key, list);

  const found: TagFinding[] = [
    ...parsed.findings,
    ...lintTags({ items: parsed.items, specTitles, phasePrefix }),
    // An .only test would run alone and silently skip every other item.
    ...findOnlyTests(titles, phasePrefix),
  ];

  const extra: string[] = [];
  if (phasePrefix === UAT_PHASE_PREFIX) {
    found.push(...checkMapAgainstScript(parsed.items, UAT_ITEM_PLAN));
    for (const file of SPEC_FILES) {
      if (!present.has(fileName(file))) extra.push(`MAP_SPEC_FILE_MISSING ${fileName(file)}`);
    }
  }
  // Items whose spec tag names a file the folder lacks are already SPEC_FILE_MISSING findings.
  const scale = UAT_ITEM_PLAN.find((entry) => entry.profile === "full")?.specFile ?? null;
  const standard = input.standardSpecs ?? specsForProfile("standard");
  if (scale !== null) {
    if (standard.some((file) => fileName(file) === fileName(scale)))
      extra.push("SCALE_IN_STANDARD");
    if (fileName(SCALE_SPEC) !== fileName(scale)) extra.push("SCALE_SPEC_MISMATCH");
  }

  const lines = [...format(found), ...extra];
  return {
    exitCode: lines.length === 0 ? 0 : 1,
    lines:
      lines.length === 0
        ? [
            `ok: no findings, ${expectedTitlesByItem(titles, phasePrefix).size} item(s) with expected tests`,
          ]
        : [...lines, `failed: ${lines.length} finding(s)`],
  };
}
