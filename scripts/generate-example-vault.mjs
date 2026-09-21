#!/usr/bin/env node
// Regenerates the committed `examples/vault/` fixture (PRIV-05).
//
// This script is the ONLY sanctioned way that tree changes. It is
// deliberately thin: it calls the real `initializeVault` from
// `@ccc/vault-repo`, so the published fixture and the code that will run
// against a user's actual vault cannot drift apart. If they ever did, the
// fixture would stop being evidence of anything.
//
// The fixture is a STATIC artifact, never a live target. No test, dev run,
// or service instance may point at it — the failure this guards against is
// a developer running the app against `examples/vault/` and committing the
// generated notes, silently growing the "empty example" into a non-empty
// one (02-RESEARCH.md, Pitfall 6). Because `initializeVault` is
// deterministic and idempotent, re-running this script against the
// committed tree must produce ZERO git diff, which is exactly what the
// plan's regeneration gate asserts:
//
//   node scripts/generate-example-vault.mjs && git diff --exit-code -- examples/vault
//
// A non-empty diff after a routine session is the warning sign that real
// content leaked in.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = join(repoRoot, "packages", "vault-repo", "dist", "index.js");
const fixtureRoot = join(repoRoot, "examples", "vault");

if (!existsSync(distEntry)) {
  // Fail loud rather than shelling out to a build: a generator that
  // silently rebuilds would make "the fixture is stale" and "the build is
  // stale" indistinguishable in CI.
  console.error(
    `Missing build output at ${distEntry}\n` +
      "Build the workspace first, then re-run this script:\n\n" +
      "  pnpm exec turbo run build\n",
  );
  process.exit(1);
}

const { initializeVault } = await import(distEntry);

// The fixture root itself is this script's to create — `initializeVault`
// deliberately refuses to create a vault root, so that a mistyped path can
// never become a second empty vault.
mkdirSync(fixtureRoot, { recursive: true });

const result = initializeVault(fixtureRoot);

console.log(
  `examples/vault regenerated: ${result.created.length} created, ${result.existing.length} already present.`,
);
