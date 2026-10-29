#!/usr/bin/env node
// The owner's presence UAT check (plan 09-15; run at the phase-end sitting, never by an agent or a test).
//
// It asks the BUILT service adapter for ONE real prompt through the installed helper
// (<runtime dir>/bin/ccc-presence), over a synthetic `diagnostic.test` message that approves nothing, then
// judges the answer:
//
//   verified     you authenticated, and the signature checks out under the public key pinned in the
//                helper-only Keychain item (read attribute-only through @ccc/keychain)
//   refused      you cancelled (or the signature did not verify): nothing was approved
//   unavailable  the helper cannot run here (not built, not enrolled, no Touch ID or password
//                available): connector-class approvals would be refused
//
// Run from a Terminal after `pnpm run build` and `pnpm run service:install`:
//   node scripts/presence/try-prompt.mjs
// The last line printed is exactly one of the three words above. Exit 0 verified, 1 refused, 2 unavailable.
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The Keychain account the helper pins its public key under (ccc-presence.m: kPinAccount). */
export const PIN_ACCOUNT = "approval-presence-pin";

/**
 * Judges a presence answer. Pure: no spawn, no Keychain. `message` is the canonical text the adapter
 * sent (the bytes the helper signed), `pin` the base64 SPKI read from the pin item (or null).
 */
export function judge({ result, message, pin }) {
  if (result.kind === "denied") return "refused";
  if (result.kind !== "proved") return "unavailable";
  if (result.scheme === "none") return "unavailable";
  if (result.scheme !== "p256" || typeof result.signature !== "string" || pin === null)
    return "unavailable";
  try {
    const key = createPublicKey({ key: Buffer.from(pin, "base64"), format: "der", type: "spki" });
    const ok = verify(
      "sha256",
      Buffer.from(message, "utf8"),
      { key, dsaEncoding: "der" },
      Buffer.from(result.signature, "base64"),
    );
    return ok ? "verified" : "refused";
  } catch {
    return "refused";
  }
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const load = (relative) => import(pathToFileURL(join(root, relative)).href);
  if (!existsSync(join(root, "packages/service/dist/approval-wiring/presence.js"))) {
    console.log("The service is not built. Run `pnpm run build` first.");
    console.log("unavailable");
    return 2;
  }
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: the sandbox switch the adapter honours
  if (process.env.CCC_INSTALL_SECRET_ACCOUNT !== undefined) {
    console.log(
      "CCC_INSTALL_SECRET_ACCOUNT is set: this is a sandbox environment, where the helper is never run.",
    );
    console.log("unavailable");
    return 2;
  }
  const { presencePortFromEnv } = await load("packages/service/dist/approval-wiring/presence.js");
  const { createExecFileCommandRunner } = await load(
    "packages/service/dist/projects/command-runner.js",
  );
  const { canonicalJson } = await load("packages/domain/dist/index.js");
  const { readItemComment } = await load("packages/keychain/dist/index.js");

  // biome-ignore lint/suspicious/noUndeclaredEnvVars: the same runtime-dir override install.sh honours
  const runtimeDir = process.env.CCC_RUNTIME_DIR ?? join(homedir(), ".claude-command-center");
  const port = presencePortFromEnv({}, runtimeDir, {
    runner: createExecFileCommandRunner(),
    exists: existsSync,
    homeDir: homedir(),
  });

  const availability = await port.availability();
  console.log(`helper availability: ${availability}`);
  if (availability !== "available") {
    console.log("unavailable");
    return 2;
  }

  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const proposalId = Array.from(randomBytes(25), (byte) => alphabet[byte % alphabet.length]).join(
    "",
  );
  const request = {
    proposalId,
    operation: "diagnostic.test",
    payloadHash: createHash("sha256").update(randomBytes(16)).digest("hex"),
    approvedAt: new Date().toISOString(),
  };
  const message = canonicalJson({
    v: 1,
    proposalId: request.proposalId,
    operation: request.operation,
    payloadHash: request.payloadHash,
    decision: "approve",
    approvedAt: request.approvedAt,
  });

  console.log(
    "A Touch ID or password sheet should appear now. Authenticate to continue, or Cancel to refuse.",
  );
  const result = await port.prove(request);
  console.log(
    `helper answer: ${result.kind}${result.kind === "proved" ? ` (${result.scheme})` : ""}`,
  );
  const pin =
    result.kind === "proved" && result.scheme === "p256"
      ? await readItemComment(PIN_ACCOUNT)
      : null;
  const verdict = judge({ result, message, pin });
  console.log(verdict);
  return verdict === "verified" ? 0 : verdict === "refused" ? 1 : 2;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.log(`try-prompt failed: ${error instanceof Error ? error.message : String(error)}`);
      console.log("unavailable");
      process.exitCode = 2;
    },
  );
}
