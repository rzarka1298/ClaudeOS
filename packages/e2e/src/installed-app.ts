import { execFileSync } from "node:child_process";
import { INSTALLED_OBSIDIAN_BINARY } from "./repo-paths.js";

/** Info.plist of the installed app, derived from the pinned binary path. */
const INFO_PLIST = INSTALLED_OBSIDIAN_BINARY.replace(/MacOS\/Obsidian$/, "Info.plist");

const SEMVER = /^\d+\.\d+\.\d+$/;

/** Validates a CFBundleShortVersionString value; returns it or throws a fixed message. */
export function parseInstallerVersion(raw: string): string {
  const version = raw.trim();
  if (!SEMVER.test(version)) throw new Error("The installed Obsidian reports no usable installer version.");
  return version;
}

/** Reads the installed app's installer version (read-only, via plutil). */
export function readInstalledInstallerVersion(plistPath: string = INFO_PLIST): string {
  const raw = execFileSync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", plistPath], {
    encoding: "utf8",
  });
  return parseInstallerVersion(raw);
}

/**
 * Fails loudly when the recorded installerVersion differs from the installed app, because the
 * chromedriver is chosen from that version and a mismatch cannot start a session (D-08).
 */
export function assertInstallerVersionMatches(recorded: string, installed: string): void {
  if (recorded !== installed) {
    throw new Error(`Installed Obsidian installer is ${installed} but the recorded decision is ${recorded}.`);
  }
}
