import { chmodSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ResearchSourcesConfig, ResearchSourcesConfigSchema } from "@ccc/domain";
import { canonicaliseUrl } from "@ccc/research";
import { DEFAULT_RESEARCH_CONFIG } from "./default-sources.js";

/**
 * The owner's source allowlist (D-07, OD-2, T-07-31): `<runtimeDir>/research-sources.json`, mode
 * 600, validated by the strict domain schema, seeded with the defaults when absent and NEVER read
 * from the vault (a note an injection wrote into the vault cannot widen the fetch list). The
 * loader touches exactly one path. A file it cannot accept is refused with a closed code and is
 * never overwritten, so the owner's hand edit is never lost.
 */

export const RESEARCH_SOURCES_FILE = "research-sources.json";

/** Larger than any valid file (twelve sources are a few kilobytes) and small enough to read whole. */
export const RESEARCH_SOURCES_MAX_BYTES = 64 * 1024;

/** The file operations the loader uses, so a test can observe them. Default: node:fs. */
export interface ResearchSourcesFs {
  lstatSync(path: string): {
    isFile(): boolean;
    isSymbolicLink(): boolean;
    readonly mode: number;
    readonly size: number;
  };
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, data: string, options: { mode: number; flag: "wx" }): void;
  chmodSync(path: string, mode: number): void;
}

export type SourcesRefusal = "unreadable" | "invalid" | "duplicate-source";

export type LoadSourcesResult =
  | { readonly ok: true; readonly config: ResearchSourcesConfig }
  | { readonly ok: false; readonly code: SourcesRefusal };

const NODE_FS: ResearchSourcesFs = { lstatSync, readFileSync, writeFileSync, chmodSync };

const OWNER_ONLY = 0o600;
const GROUP_OR_OTHER = 0o077;

function missing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
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

/**
 * Reads, repairs the permissions of, validates and returns the allowlist; seeds it first when
 * the file is absent. Never throws.
 */
export function loadResearchSources(
  runtimeDir: string,
  fs: ResearchSourcesFs = NODE_FS,
): LoadSourcesResult {
  const path = join(runtimeDir, RESEARCH_SOURCES_FILE);
  let stat: ReturnType<ResearchSourcesFs["lstatSync"]>;
  try {
    stat = fs.lstatSync(path);
  } catch (error) {
    if (!missing(error)) return { ok: false, code: "unreadable" };
    try {
      fs.writeFileSync(path, `${JSON.stringify(DEFAULT_RESEARCH_CONFIG, null, 2)}\n`, {
        mode: OWNER_ONLY,
        flag: "wx",
      });
      fs.chmodSync(path, OWNER_ONLY);
    } catch {
      return { ok: false, code: "unreadable" };
    }
    return { ok: true, config: DEFAULT_RESEARCH_CONFIG };
  }

  // A link or a folder is not the owner's file.
  if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false, code: "unreadable" };
  if (stat.size > RESEARCH_SOURCES_MAX_BYTES) return { ok: false, code: "invalid" };
  if ((stat.mode & GROUP_OR_OTHER) !== 0) {
    try {
      fs.chmodSync(path, OWNER_ONLY);
    } catch {
      return { ok: false, code: "unreadable" };
    }
  }

  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch {
    return { ok: false, code: "unreadable" };
  }
  let parsed: ReturnType<typeof ResearchSourcesConfigSchema.safeParse>;
  try {
    parsed = ResearchSourcesConfigSchema.safeParse(JSON.parse(raw));
  } catch {
    return { ok: false, code: "invalid" };
  }
  if (!parsed.success) return { ok: false, code: "invalid" };
  if (hasDuplicateSource(parsed.data)) return { ok: false, code: "duplicate-source" };
  return { ok: true, config: parsed.data };
}
