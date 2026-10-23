/**
 * What a live-UAT script may look like at each stage of the merge gate (plan 08-23, T-08-55, D-46).
 *
 * Agents ship the script with every result `[pending]` and no automated result. At the merge gate
 * the runner writes `auto-result:` lines, the ratification turns a passing automated result into
 * `result: pass - auto run <id>` (and moves the summary counts), and the owner records the owner
 * items; only then does the front matter say `status: complete`. The structure tests call
 * {@link recordedStateProblems} so they keep passing through those steps while still refusing the
 * one thing that must never happen: an owner result that the owner did not give.
 *
 * Test support only; it reads text and returns problems, one short sentence each, never a quote.
 */

export interface RecordedStateOptions {
  /** The number of items the script must hold. */
  readonly total: number;
  /** The item numbers tagged `run: owner`. */
  readonly ownerItems: readonly number[];
}

/** The runner's own form of an auto-result value (`uat-tags.ts`). */
const AUTO_RESULT =
  /^(pass|fail|inconclusive|inconclusive \(look pending\)) @ ([0-9a-f]{8}) \d{4}-\d{2}-\d{2}$/;
const RATIFIED = /^pass - auto run ([0-9a-f]{8})$/;

interface Block {
  readonly number: number;
  readonly body: string;
}

function blocks(text: string): Block[] {
  const parts = text.split(/^### (\d+)\. .+$/m);
  const out: Block[] = [];
  for (let index = 1; index < parts.length; index += 2) {
    const body = (parts[index + 1] ?? "").split(/^## /m)[0] as string;
    out.push({ number: Number(parts[index]), body });
  }
  return out;
}

function lineValues(body: string, key: string): string[] {
  const pattern = new RegExp(`^${key}: ?(.*)$`, "gm");
  return [...body.matchAll(pattern)].map((m) => (m[1] as string).trim());
}

export function recordedStateProblems(text: string, options: RecordedStateOptions): string[] {
  const problems: string[] = [];
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const complete = /^status: complete$/m.test(front);
  const items = blocks(text);
  if (items.length !== options.total) problems.push(`the script holds ${items.length} items`);

  let pending = 0;
  let ownerPending = 0;
  let ratified = 0;
  let autoResultLines = 0;
  for (const item of items) {
    const where = `item ${item.number}`;
    const owner = options.ownerItems.includes(item.number);
    const results = lineValues(item.body, "result");
    if (results.length !== 1) {
      problems.push(`${where}: expected exactly one result line, found ${results.length}`);
      continue;
    }
    const result = results[0] as string;
    const autos = lineValues(item.body, "auto-result");
    autoResultLines += autos.length;
    if (autos.length > 1) problems.push(`${where}: more than one auto-result line`);
    if (owner && autos.length > 0) problems.push(`${where}: an owner item carries an auto-result`);
    for (const auto of autos) {
      if (!AUTO_RESULT.test(auto))
        problems.push(`${where}: the auto-result is not in the runner's form`);
    }
    if (result === "[pending]") {
      pending += 1;
      if (owner) ownerPending += 1;
      continue;
    }
    if (complete) continue;
    // Not complete: only a ratified automated pass may stand in for a pending result.
    const run = RATIFIED.exec(result)?.[1];
    if (owner || run === undefined) {
      problems.push(
        `${where}: a result is recorded that only the owner may give before the script is complete`,
      );
      continue;
    }
    const auto = autos[0] === undefined ? undefined : AUTO_RESULT.exec(autos[0]);
    if (auto === null || auto === undefined || auto[1] !== "pass" || auto[2] !== run) {
      problems.push(`${where}: a ratified pass has no passing auto-result of the same run`);
      continue;
    }
    ratified += 1;
  }

  if (!complete) {
    if (/^(reported|severity|reason|blocked_by):/m.test(text)) {
      problems.push("an issue note is recorded before the script is complete");
    }
  }

  // The summary agrees with the results.
  const summary = (/^## Summary\b[\s\S]*?(?=^## |$(?![\s\S]))/m.exec(text)?.[0] ?? "").trim();
  const count = (key: string): number =>
    Number(new RegExp(`^${key}: (\\d+)$`, "m").exec(summary)?.[1]);
  const need = (key: string): boolean => {
    const ok = Number.isInteger(count(key));
    if (!ok) problems.push(`the summary has no ${key} count`);
    return ok;
  };
  if (need("total") && count("total") !== options.total)
    problems.push("the summary total is wrong");
  const keys = ["passed", "issues", "pending", "skipped", "blocked"];
  if (keys.every(need)) {
    const sum = keys.reduce((total, key) => total + count(key), 0);
    if (sum !== options.total) problems.push("the summary counts do not add up to the total");
    if (count("pending") !== pending)
      problems.push("the summary pending count differs from the results");
    if (!complete && count("passed") !== ratified) {
      problems.push("the summary passed count differs from the ratified results");
    }
  }
  if (need("owner-pending") && count("owner-pending") !== ownerPending) {
    problems.push("the summary owner-pending count differs from the owner items still pending");
  }
  for (const key of ["auto-passed", "auto-failed"]) {
    if (need(key) && count(key) > autoResultLines) {
      problems.push(`the summary ${key} count is larger than the auto-result lines`);
    }
  }
  return problems;
}
