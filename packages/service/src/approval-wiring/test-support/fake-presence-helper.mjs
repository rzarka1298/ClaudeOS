// A stand-in for the presence helper (plan 09-15, T-09-33). It is never the real
// helper: it shows no prompt, touches no Keychain item and signs nothing. A test
// copies this file to a temporary absolute path as `ccc-presence`, prepends a
// `#!<absolute node>` line, makes it executable and writes `control.json` next
// to it. Every run:
//   - appends one JSON line {argv, envKeys, home} to `calls.log` next to it,
//   - then does what `control.json` says: wait `sleepMs`, print `stdout` (or
//     `repeat` copies of `stdoutChunk`), print `stderr`, exit with `exit`.
// `control.json` may also hold `perSubcommand`, an object keyed by the first
// argument (check, prove) holding the same members, for a test that needs the
// two subcommands to answer differently.
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

appendFileSync(
  join(here, "calls.log"),
  `${JSON.stringify({ argv, envKeys: Object.keys(process.env).sort(), home: process.env.HOME ?? null })}\n`,
);

const control = JSON.parse(readFileSync(join(here, "control.json"), "utf8"));
const spec = control.perSubcommand?.[argv[0]] ?? control;

if (typeof spec.sleepMs === "number" && spec.sleepMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, spec.sleepMs));
}
if (typeof spec.stdout === "string") process.stdout.write(spec.stdout);
if (typeof spec.stdoutChunk === "string") {
  for (let i = 0; i < (spec.repeat ?? 1); i += 1) process.stdout.write(spec.stdoutChunk);
}
if (typeof spec.stderr === "string") process.stderr.write(spec.stderr);
process.exitCode = typeof spec.exit === "number" ? spec.exit : 0;
