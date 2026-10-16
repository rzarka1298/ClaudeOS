import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import { type ResearchSourcesConfig, ResearchSourcesConfigSchema } from "@ccc/domain";
import { canonicaliseUrl } from "@ccc/research";
import { DEFAULT_RESEARCH_CONFIG } from "./default-sources.js";

/**
 * The owner's source allowlist (D-07, OD-2, T-07-31): `<runtimeDir>/research-sources.json`, mode
 * 600, validated by the strict domain schema, seeded with the defaults when absent and NEVER read
 * from the vault (a note an injection wrote into the vault cannot widen the fetch list). The
 * loader touches exactly one path. A file it cannot accept is refused with a closed code and is
 * never overwritten, so the owner's hand edit is never lost.
 *
 * Hardening (plan 07-14, wave 4 opus m1): the file is opened ONCE, without following a link, and
 * everything after that (owner, size, mode repair, the read) happens on that descriptor, so the
 * file that was validated is the file that is read; the size cap is enforced on the bytes read,
 * not on the size reported; a file another account owns is refused; and a runtime directory that
 * resolves inside the vault is refused (a note in the vault could then edit the allowlist).
 * {@link peekResearchSources} reads the same file for display and changes nothing.
 */

export const RESEARCH_SOURCES_FILE = "research-sources.json";

/** Larger than any valid file (twelve sources are a few kilobytes) and small enough to read whole. */
export const RESEARCH_SOURCES_MAX_BYTES = 64 * 1024;

/** The file operations the loader uses, so a test can observe them. Default: node:fs. */
export interface ResearchSourcesFs {
  openSync(path: string, flags: number): number;
  fstatSync(fd: number): {
    isFile(): boolean;
    readonly mode: number;
    readonly size: number;
    readonly uid: number;
  };
  readSync(
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ): number;
  closeSync(fd: number): void;
  fchmodSync(fd: number, mode: number): void;
  writeFileSync(path: string, data: string, options: { mode: number; flag: "wx" }): void;
  realpathSync(path: string): string;
  /** The account running the service, or -1 where there is none. */
  getuid(): number;
}

export type SourcesRefusal = "unreadable" | "invalid" | "duplicate-source" | "inside-vault";

export type LoadSourcesResult =
  | { readonly ok: true; readonly config: ResearchSourcesConfig }
  | { readonly ok: false; readonly code: SourcesRefusal };

const NODE_FS: ResearchSourcesFs = {
  openSync,
  fstatSync,
  readSync,
  closeSync,
  fchmodSync,
  writeFileSync,
  realpathSync,
  getuid: () => process.getuid?.() ?? -1,
};

export interface LoadSourcesOptions {
  /** The managed vault root. A runtime directory at or below it is refused. */
  readonly vaultRoot?: string | null;
}

const OWNER_ONLY = 0o600;
const GROUP_OR_OTHER = 0o077;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CHUNK_BYTES = 8192;

function missing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

function exists(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "EEXIST";
}

/** True when the runtime directory is the vault or below it, with links resolved. */
function isInsideVault(runtimeDir: string, vaultRoot: string, fs: ResearchSourcesFs): boolean {
  let runtime: string;
  let vault: string;
  try {
    runtime = fs.realpathSync(runtimeDir);
    vault = fs.realpathSync(vaultRoot);
  } catch {
    // A directory that cannot be resolved holds no file to protect (the open then fails).
    return false;
  }
  return runtime === vault || runtime.startsWith(vault.endsWith(sep) ? vault : `${vault}${sep}`);
}

/** True when two entries name one address after canonicalisation (the fallback is the raw text). */
function hasDuplicateSource(config: ResearchSourcesConfig): boolean {
  const seen = new Set<string>();
  for (const entry of config.sources) {
    const canonical = canonicaliseUrl(entry.url);
    const key = canonical.ok ? canonical.url : entry.url;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

type ReadOutcome =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "refused"; readonly code: SourcesRefusal }
  | { readonly kind: "absent" };

/**
 * Opens the file once and reads it whole through that descriptor. `repair` fixes a loose mode on
 * the descriptor (the loader does; a display read never does).
 */
function readThroughDescriptor(path: string, fs: ResearchSourcesFs, repair: boolean): ReadOutcome {
  let fd: number;
  try {
    fd = fs.openSync(path, READ_FLAGS);
  } catch (error) {
    // A link (ELOOP), a permission refusal or anything else is not the owner's file.
    return missing(error) ? { kind: "absent" } : { kind: "refused", code: "unreadable" };
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { kind: "refused", code: "unreadable" };
    if (stat.uid !== fs.getuid()) return { kind: "refused", code: "unreadable" };
    if (stat.size > RESEARCH_SOURCES_MAX_BYTES) return { kind: "refused", code: "invalid" };
    if (repair && (stat.mode & GROUP_OR_OTHER) !== 0) {
      try {
        fs.fchmodSync(fd, OWNER_ONLY);
      } catch {
        return { kind: "refused", code: "unreadable" };
      }
    }
    // The cap is enforced on what is actually read: a file that grew after the check is refused.
    const chunks: Buffer[] = [];
    let total = 0;
    const buffer = Buffer.alloc(CHUNK_BYTES);
    for (;;) {
      let read: number;
      try {
        read = fs.readSync(fd, buffer, 0, CHUNK_BYTES, null);
      } catch {
        return { kind: "refused", code: "unreadable" };
      }
      if (read === 0) break;
      total += read;
      if (total > RESEARCH_SOURCES_MAX_BYTES) return { kind: "refused", code: "invalid" };
      chunks.push(Buffer.from(buffer.subarray(0, read)));
    }
    return { kind: "text", text: Buffer.concat(chunks).toString("utf8") };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // A descriptor that cannot be closed changes nothing the caller can act on.
    }
  }
}

function parseConfig(text: string): LoadSourcesResult {
  let parsed: ReturnType<typeof ResearchSourcesConfigSchema.safeParse>;
  try {
    parsed = ResearchSourcesConfigSchema.safeParse(JSON.parse(text));
  } catch {
    return { ok: false, code: "invalid" };
  }
  if (!parsed.success) return { ok: false, code: "invalid" };
  if (hasDuplicateSource(parsed.data)) return { ok: false, code: "duplicate-source" };
  return { ok: true, config: parsed.data };
}

/**
 * Reads, repairs the permissions of, validates and returns the allowlist; seeds it first when
 * the file is absent. Never throws. Refuses a runtime directory inside the vault before touching
 * anything.
 */
export function loadResearchSources(
  runtimeDir: string,
  fs: ResearchSourcesFs = NODE_FS,
  options: LoadSourcesOptions = {},
): LoadSourcesResult {
  if (
    options.vaultRoot !== undefined &&
    options.vaultRoot !== null &&
    isInsideVault(runtimeDir, options.vaultRoot, fs)
  ) {
    return { ok: false, code: "inside-vault" };
  }
  const path = join(runtimeDir, RESEARCH_SOURCES_FILE);
  // Two attempts: a file that appears between the failed open and the seeding write is read, not
  // overwritten (the write is exclusive).
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const outcome = readThroughDescriptor(path, fs, true);
    if (outcome.kind === "text") return parseConfig(outcome.text);
    if (outcome.kind === "refused") return { ok: false, code: outcome.code };
    try {
      fs.writeFileSync(path, `${JSON.stringify(DEFAULT_RESEARCH_CONFIG, null, 2)}\n`, {
        mode: OWNER_ONLY,
        flag: "wx",
      });
      return { ok: true, config: DEFAULT_RESEARCH_CONFIG };
    } catch (error) {
      if (!exists(error)) return { ok: false, code: "unreadable" };
    }
  }
  return { ok: false, code: "unreadable" };
}

/**
 * Reads the allowlist for DISPLAY (the status route): the same checks and codes as
 * {@link loadResearchSources}, but nothing is written or changed. An absent file answers the
 * defaults that the next run would seed; a loose mode is left as it is.
 */
export function peekResearchSources(
  runtimeDir: string,
  fs: ResearchSourcesFs = NODE_FS,
  options: LoadSourcesOptions = {},
): LoadSourcesResult {
  if (
    options.vaultRoot !== undefined &&
    options.vaultRoot !== null &&
    isInsideVault(runtimeDir, options.vaultRoot, fs)
  ) {
    return { ok: false, code: "inside-vault" };
  }
  const outcome = readThroughDescriptor(join(runtimeDir, RESEARCH_SOURCES_FILE), fs, false);
  if (outcome.kind === "text") return parseConfig(outcome.text);
  if (outcome.kind === "refused") return { ok: false, code: outcome.code };
  return { ok: true, config: DEFAULT_RESEARCH_CONFIG };
}
