import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ResearchSourcesConfig, ResearchSourcesConfigSchema } from "@ccc/domain";

/** The owner's source allowlist file, inside the runtime directory (never the vault, D-07). */
export const RESEARCH_SOURCES_FILE = "research-sources.json";

/** The file operations the loader uses, so a test can observe them. Default: node:fs. */
export interface ResearchSourcesFs {
  readFileSync(path: string, encoding: "utf8"): string;
}

export type LoadSourcesResult =
  | { readonly ok: true; readonly config: ResearchSourcesConfig }
  | { readonly ok: false; readonly code: "unreadable" | "invalid" };

const NODE_FS: ResearchSourcesFs = { readFileSync };

/** Reads and validates the allowlist (the tracer version; seeding and hardening follow in Task 2). */
export function loadResearchSources(
  runtimeDir: string,
  fs: ResearchSourcesFs = NODE_FS,
): LoadSourcesResult {
  let raw: string;
  try {
    raw = fs.readFileSync(join(runtimeDir, RESEARCH_SOURCES_FILE), "utf8");
  } catch {
    return { ok: false, code: "unreadable" };
  }
  try {
    const parsed = ResearchSourcesConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? { ok: true, config: parsed.data } : { ok: false, code: "invalid" };
  } catch {
    return { ok: false, code: "invalid" };
  }
}
