#!/usr/bin/env node
// Owner-run storage of the Anthropic API key for the research summariser (plan 07-10, D-04,
// ADR-0017, research Pitfall 16).
//
//   node scripts/research-key-setup.mjs            store the key, read from standard input
//   node scripts/research-key-setup.mjs --check    report configured or not configured
//   node scripts/research-key-setup.mjs --help     explain all of this
//
// The key is read from standard input only, never from an argument (an argument would sit in the
// process list and the shell history). It goes to the macOS Keychain through the built
// `@ccc/keychain` wrapper, which writes it over `security -i` stdin as well. The script never
// prints the key, never prints an error's text (an error from a tool can quote its input), and
// stores nothing when it is given any argument other than --check or --help.
//
// `main(deps)` is exported so the test can inject a secret-store stub; the command-line entry at
// the bottom builds the real dependencies and is the only place that touches the real Keychain.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The Keychain account of the key. Duplicated from `RESEARCH_API_KEY_ACCOUNT` in
 * `packages/service/src/research/research-key.ts` so this script does not need the service build;
 * `packages/test-fixtures/src/research-key-setup.test.ts` asserts the two are equal.
 */
export const RESEARCH_KEY_ACCOUNT = "anthropic-api-key";

/** A real key is about 110 characters; more than this on stdin is a mistake, not a key. */
const MAX_KEY_CHARS = 512;

/**
 * What the summariser transport accepts as a key: the keychain package's safe alphabet, so a header
 * value is inert. Duplicated from `KEY_PATTERN` in `packages/service/src/research/anthropic-transport.ts`
 * (this script does not need the service build); `packages/test-fixtures/src/research-key-setup.test.ts`
 * checks the two agree on a set of samples. A key outside it would be stored and then never used.
 */
const KEY_PATTERN = /^[A-Za-z0-9+/=_-]{1,512}$/;

const REFUSED_ARGUMENTS_MESSAGE =
  "this script takes no arguments except --check and --help; the key is read from standard input";
const UNUSABLE_KEY_MESSAGE =
  "the key was not stored: it is not in the form the research summariser accepts (letters, digits and + / = _ - only, 1 to 512 characters)";
const WRAPPER_REFUSAL_MESSAGE = "the key contains characters the keychain wrapper refuses";

function helpLines(serviceName) {
  return [
    "Store the Anthropic API key used by the research summariser in the macOS Keychain.",
    "",
    "Usage:",
    "  node scripts/research-key-setup.mjs           store the key (read from standard input)",
    "  node scripts/research-key-setup.mjs --check   report configured or not configured",
    "  node scripts/research-key-setup.mjs --help    show this text",
    "",
    "The key is read from standard input, never from an argument, so it does not appear in the",
    "process list or in your shell history. In a terminal you are prompted and nothing is echoed;",
    "from a pipe, send the key on one line. The key is never printed.",
    "",
    `Keychain service: ${serviceName}`,
    `Keychain account: ${RESEARCH_KEY_ACCOUNT}`,
    "",
    "macOS may ask once to allow keychain access the first time the key is stored or read.",
    "Choose Always Allow for this tool if you want the prompt not to repeat.",
  ];
}

/**
 * Reads the key from a stream and removes one trailing line break (`\n` or `\r\n`) and nothing else.
 * Rejects input longer than MAX_KEY_CHARS plus a line break without keeping it.
 */
export async function readKeyFromStream(stream) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const piece = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    total += piece.byteLength;
    if (total > MAX_KEY_CHARS + 2) throw new Error("the key on standard input is too long");
    chunks.push(piece);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

/** Reads a key from a terminal with echo off; Enter ends it, Backspace edits, Ctrl-C aborts. */
async function readKeyFromTerminal(input, write) {
  write("Paste the Anthropic API key, then press Enter (nothing is shown): ");
  return await new Promise((resolveKey, rejectKey) => {
    let key = "";
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const finish = (error) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      write("\n");
      if (error) rejectKey(error);
      else resolveKey(key);
    };
    const onData = (data) => {
      for (const ch of data) {
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\u0003") return finish(new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") key = key.slice(0, -1);
        else if (ch >= " ") key += ch;
        if (key.length > MAX_KEY_CHARS) return finish(new Error("the key is too long"));
      }
    };
    input.on("data", onData);
  });
}

/**
 * @param {{
 *   argv: string[],
 *   readKey: () => Promise<string>,
 *   store: { get(account: string): Promise<string | null>, set(account: string, value: string): Promise<void> },
 *   serviceName: string,
 *   out: (line: string) => void,
 *   err: (line: string) => void,
 * }} deps
 * @returns {Promise<number>} the process exit code
 */
export async function main(deps) {
  const { argv, readKey, store, serviceName, out, err } = deps;
  // Nothing about an unexpected argument is echoed: it may be the key itself.
  const mode =
    argv.length === 0
      ? "store"
      : argv.length === 1 && argv[0] === "--check"
        ? "check"
        : argv.length === 1 && argv[0] === "--help"
          ? "help"
          : null;
  if (mode === null) {
    err(REFUSED_ARGUMENTS_MESSAGE);
    return 2;
  }
  if (mode === "help") {
    for (const line of helpLines(serviceName)) out(line);
    return 0;
  }
  if (mode === "check") {
    let stored;
    try {
      stored = await store.get(RESEARCH_KEY_ACCOUNT);
    } catch {
      err("could not read the keychain");
      return 1;
    }
    const configured = typeof stored === "string" && stored.length > 0;
    out(
      `research API key: ${configured ? "configured" : "not configured"} (account ${RESEARCH_KEY_ACCOUNT})`,
    );
    return configured ? 0 : 1;
  }

  let key;
  try {
    key = await readKey();
  } catch {
    err("could not read the key from standard input");
    return 1;
  }
  if (typeof key !== "string" || key.trim().length === 0) {
    err("no key was provided on standard input");
    return 1;
  }
  // Nothing about the key is echoed, not even which character is wrong.
  if (!KEY_PATTERN.test(key)) {
    err(UNUSABLE_KEY_MESSAGE);
    return 1;
  }
  try {
    await store.set(RESEARCH_KEY_ACCOUNT, key);
  } catch (error) {
    if (error instanceof Error && error.name === "UnsafeSecretInputError") {
      err(WRAPPER_REFUSAL_MESSAGE);
    } else {
      err("could not store the key in the keychain");
    }
    return 1;
  }
  out(`stored the research API key (service ${serviceName}, account ${RESEARCH_KEY_ACCOUNT})`);
  return 0;
}

async function realDeps(argv) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const distEntry = join(repoRoot, "packages", "keychain", "dist", "index.js");
  if (!existsSync(distEntry)) {
    // Fail loud rather than shelling out to a build, as scripts/generate-example-vault.mjs does.
    console.error(
      `Missing build output at ${distEntry}\nBuild the keychain package first, then re-run this script:\n\n  pnpm exec turbo run build --filter=@ccc/keychain\n`,
    );
    process.exit(1);
  }
  const { createSecurityCliSecretStore, SERVICE_NAME } = await import(
    pathToFileURL(distEntry).href
  );
  const readKey = process.stdin.isTTY
    ? () => readKeyFromTerminal(process.stdin, (text) => process.stderr.write(text))
    : () => readKeyFromStream(process.stdin);
  return {
    argv,
    readKey,
    store: createSecurityCliSecretStore(),
    serviceName: SERVICE_NAME,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  // Refused and help paths need no Keychain build; the others build the real store.
  const deps =
    argv.length === 0 || (argv.length === 1 && argv[0] === "--check")
      ? await realDeps(argv)
      : {
          argv,
          readKey: async () => "",
          store: { get: async () => null, set: async () => undefined },
          serviceName: "com.claude-command-center",
          out: (line) => console.log(line),
          err: (line) => console.error(line),
        };
  process.exitCode = await main(deps);
}
