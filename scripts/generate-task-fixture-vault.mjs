#!/usr/bin/env node
// Generates a throwaway, fully synthetic task vault for live checks and the
// ten-thousand-task responsiveness run (plan 06-28, D-46, TASK-09, PRIV-01).
//
// Thin wrapper: the notes come from the same `generateTaskVault` helper the
// test suites use, so the vault the owner opens and the vault the tests prove
// are produced by one code path. It writes ONLY into a new or empty folder
// outside the repository, never into the home directory itself and never
// inside an Obsidian vault. Every refusal prints one fixed line that names the
// offending argument and nothing else.

import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = join(repoRoot, "packages", "test-fixtures", "dist", "task-fixtures.js");

const HELP = `Usage: node scripts/generate-task-fixture-vault.mjs --out FOLDER [options]

Generates a synthetic task vault. FOLDER must be new or empty and outside the repository.

Flags:
  --out FOLDER     output folder (required)
  --count N        number of generated task notes, 1 to 50000 (default 300)
  --seed N         integer seed; the same seed, count and clock give identical files
  --clock ISO      instant the dates are relative to, e.g. 2026-10-08T09:00:00Z (default now)
  --zone ZONE      IANA time zone the dates are relative to (default the machine zone)
  --live-check     also write the live-check notes (Properties-style date, three proposed
                   tasks, one oversize and one unparseable note)
  --help           print this text
`;

function refuse(argument) {
  console.error(`generate-task-fixture-vault: refused (${argument})`);
  process.exit(2);
}

let values;
try {
  ({ values } = parseArgs({
    options: {
      out: { type: "string" },
      count: { type: "string" },
      seed: { type: "string" },
      clock: { type: "string" },
      zone: { type: "string" },
      "live-check": { type: "boolean" },
      help: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  }));
} catch {
  refuse("arguments");
}

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

// Validate every argument before touching the file system.
if (values.out === undefined || values.out === "") refuse("--out");
let count = 300;
if (values.count !== undefined) {
  if (!/^[0-9]{1,6}$/.test(values.count)) refuse("--count");
  count = Number(values.count);
  if (count < 1 || count > 50_000) refuse("--count");
}
let seed;
if (values.seed !== undefined) {
  if (!/^[0-9]{1,9}$/.test(values.seed)) refuse("--seed");
  seed = Number(values.seed);
}
let now = new Date();
if (values.clock !== undefined) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/.test(values.clock)) {
    refuse("--clock");
  }
  now = new Date(values.clock);
  if (Number.isNaN(now.getTime())) refuse("--clock");
}
let zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
if (values.zone !== undefined) {
  zone = values.zone;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
  } catch {
    refuse("--zone");
  }
}

// Resolve the output path through real paths on every side, even when it does not exist yet.
function realResolve(path) {
  const absolute = resolve(path);
  const tail = [];
  let current = absolute;
  while (!existsSync(current)) {
    tail.unshift(basename(current));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return join(realpathSync(current), ...tail);
}

const out = realResolve(values.out);
const inside = (child, parent) => child === parent || child.startsWith(parent + sep);
if (inside(out, realpathSync(repoRoot))) refuse("--out");
if (out === realpathSync(homedir()) || out === dirname(out)) refuse("--out");
if (existsSync(out)) {
  if (!statSync(out).isDirectory()) refuse("--out");
  if (readdirSync(out).length > 0) refuse("--out");
}
// Never inside a real vault: no ancestor may hold an Obsidian settings folder.
for (let up = dirname(out); ; up = dirname(up)) {
  if (existsSync(join(up, ".obsidian"))) refuse("--out");
  if (dirname(up) === up) break;
}

if (!existsSync(distEntry)) {
  console.error(
    `Missing build output at packages/test-fixtures/dist/task-fixtures.js\n` +
      "Build the workspace first, then re-run this script:\n\n" +
      "  pnpm exec turbo run build --filter=@ccc/test-fixtures\n",
  );
  process.exit(1);
}

const { generateTaskVault, writeLiveCheckNotes } = await import(distEntry);

mkdirSync(out, { recursive: true });
const generated = generateTaskVault(out, {
  count,
  now,
  zone,
  ...(seed === undefined ? {} : { seed }),
});
let extra = 0;
if (values["live-check"]) {
  const live = writeLiveCheckNotes(out, {
    now,
    zone,
    ...(seed === undefined ? {} : { seed }),
  });
  extra = live.tasks.length + live.unreadable.length;
}
console.log(
  `generated ${generated.tasks.length} task notes${values["live-check"] ? ` plus ${extra} live-check notes` : ""} in ${generated.scopes.length} scopes`,
);
console.log(`vault folder: ${out}`);
