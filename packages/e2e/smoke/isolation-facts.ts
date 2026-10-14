/**
 * Reads, from inside the launched sandbox Obsidian, the two facts that decide which service
 * socket the plugin talks to (Codex finding 1): the CCC_SOCKET_PATH the renderer sees and the
 * socketPathOverride persisted in the vault's plugin data.json (which the plugin prefers).
 * The verdict itself is the pure evaluateSocketIsolation in ../src/vault-plugin-data.ts.
 */
import { browser } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";
import type { SocketIsolationFacts } from "../src/vault-plugin-data.js";
import { PLUGIN_ID } from "../src/vault-plugin-data.js";

export async function readIsolationFacts(): Promise<SocketIsolationFacts> {
  const seenByRenderer = await browser.executeObsidian(() =>
    typeof process === "undefined" ? null : (process.env.CCC_SOCKET_PATH ?? null),
  );

  let persistedOverride: string | null | undefined;
  try {
    const configDir = await obsidianPage.getConfigDir();
    const raw = await obsidianPage.read(`${configDir}/plugins/${PLUGIN_ID}/data.json`);
    const value = (JSON.parse(raw) as { socketPathOverride?: unknown }).socketPathOverride;
    // A non-string, non-null value cannot be a valid override; surface it as a mismatch.
    persistedOverride = typeof value === "string" || value === null ? value : "(not a string)";
  } catch {
    // No data.json in the launched vault: the environment variable alone decides.
    persistedOverride = undefined;
  }

  return { expected: process.env.CCC_SOCKET_PATH, seenByRenderer, persistedOverride };
}
