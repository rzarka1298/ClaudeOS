import {
  GENERATED_BY_KEY_ORDER,
  type GeneratedBy,
  NOTE_FRONTMATTER_KEY_ORDER,
  type NoteFrontmatter,
} from "@ccc/domain/note-schema.js";
import {
  TASK_DECISION_KEY_ORDER,
  TASK_FRONTMATTER_KEY_ORDER,
  type TaskFrontmatter,
} from "@ccc/domain/task-schema.js";
import yaml from "js-yaml";

/**
 * The plugin's canonical managed-frontmatter serializer: the one place in
 * this package that turns provenance values into YAML bytes.
 *
 * ## Why this module exists rather than a call to Obsidian's stringifyYaml
 *
 * VAULT-06's contract is that a note written by the plugin and the same note
 * written by the companion service are BYTE-IDENTICAL. Until this module,
 * the plugin reached that through Obsidian's bundled `stringifyYaml`, on the
 * assumption that Obsidian's YAML surface and the service's js-yaml (reached
 * through gray-matter's default engine) were the same serializer with the
 * same options.
 *
 * Phase 2's live-Obsidian UAT (2026-09-22) disproved that assumption. Probed
 * side by side against the service's `safeDump`, Obsidian's serializer
 * differed in three value classes:
 *
 * | value                       | Obsidian                  | service (js-yaml)            |
 * | --------------------------- | ------------------------- | ---------------------------- |
 * | `"colon: and #hash"`        | `"colon: and #hash"`      | `'colon: and #hash'`         |
 * | `"Repair \u{1F6E0} ..."`    | plain, unescaped          | `"Repair \U0001F6E0 ..."`    |
 * | `"0123456789..."`           | quoted                    | bare                         |
 *
 * Those are not cosmetic. A note round-tripped between the two writers would
 * change bytes with no content change, which breaks VAULT-03/VAULT-04's
 * determinism guarantee, makes every content hash and every "has this file
 * changed?" comparison unreliable, and shows up in the user's Git history as
 * a phantom diff.
 *
 * Obsidian exposes no options on `stringifyYaml`, so there is no way to
 * bring the two into agreement through its API. The fix is therefore
 * structural: the plugin BUNDLES the same js-yaml the service reaches and
 * calls the same `safeDump` entry point, so parity is a property of shared
 * code rather than of two libraries happening to agree. `js-yaml` is a real
 * dependency of this package (not a devDependency) and is deliberately NOT
 * externalised in `esbuild.config.mjs` — Obsidian provides no js-yaml to a
 * plugin at runtime, so an externalised import would resolve to nothing.
 *
 * Do not reintroduce `stringifyYaml` here. `frontmatter-serializer.test.ts`
 * pins all three divergence classes to the service's bytes and scans this
 * file for an `obsidian` import, because under Vitest the `obsidian` module
 * resolves to a js-yaml-backed stub that would make the regression invisible
 * to a behavioural test alone.
 *
 * ## Why one key at a time
 *
 * Every entry is dumped as its own single-entry document and the results are
 * concatenated. That is what makes key order a property of the loops below
 * rather than of the YAML library's object handling: no object with more
 * than one key is ever handed to the serializer at the top level, so there
 * is no insertion order for it to honour or ignore. At top level a
 * single-entry dump is byte-identical to that entry's lines inside a
 * whole-object dump, which is why the output still matches the service
 * writer — which dumps the whole map at once — exactly.
 */

/** One `key: value` entry, dumped on its own. See the module note above. */
function dumpEntry(key: string, value: unknown): string {
  return yaml.safeDump({ [key]: value });
}

/**
 * Rebuilds the nested `generatedBy` map in `GENERATED_BY_KEY_ORDER`,
 * dropping absent subfields — the same two rules the service-side
 * serializer follows, and for the same two reasons: YAML cannot dump
 * `undefined`, and an explicit `model: null` would assert "no model" where
 * the schema means "model unknown".
 */
function orderedGeneratedBy(value: GeneratedBy): Record<string, string> {
  const ordered: Record<string, string> = {};
  for (const key of GENERATED_BY_KEY_ORDER) {
    const sub = value[key];
    if (sub !== undefined) ordered[key] = sub;
  }
  return ordered;
}

/**
 * Emits the managed provenance block (no `---` delimiters), one key at a
 * time, in `NOTE_FRONTMATTER_KEY_ORDER`.
 *
 * The returned string always ends in a newline, so a caller can concatenate
 * it directly against the closing delimiter.
 */
export function serializeManagedFrontmatter(frontmatter: NoteFrontmatter): string {
  const source = frontmatter as unknown as Record<string, unknown>;
  let out = "";
  for (const key of NOTE_FRONTMATTER_KEY_ORDER) {
    const value = source[key];
    if (value === undefined) continue;
    out += dumpEntry(key, key === "generatedBy" ? orderedGeneratedBy(value as GeneratedBy) : value);
  }
  return out;
}

/**
 * Emits the note's non-managed ("user") keys — `tags`, `aliases`,
 * `cssclasses`, Dataview inline fields, Templater metadata — in the order
 * given, which is the order they were read off disk.
 *
 * These belong to the USER, not to this system, and the caller re-emits them
 * after the managed block rather than dropping them: `NoteFrontmatterSchema`
 * is a plain `z.object` and zod strips unknown keys, so rebuilding a block
 * from validated data alone would silently delete every one of them.
 */
export function serializePassthroughFrontmatter(
  entries: readonly (readonly [string, unknown])[],
): string {
  let out = "";
  for (const [key, value] of entries) {
    // js-yaml refuses to dump `undefined`; a key whose parsed value is
    // `undefined` carries no information to preserve, so dropping it loses
    // nothing a round-trip could have kept.
    if (value === undefined) continue;
    out += dumpEntry(key, value);
  }
  return out;
}

/**
 * Emits a task note's frontmatter block (no `---` delimiters): the keys in
 * `TASK_FRONTMATTER_KEY_ORDER`, `generatedBy` and `decision` in their own fixed
 * orders, then the passthrough keys in read order (plan 06-18, research
 * Pattern 11).
 *
 * It is the plugin twin of `@ccc/vault-repo`'s `stringifyTaskNote`: the same
 * per-key dump of the same js-yaml, walking the same arrays, so a note written
 * by either process has the same bytes (proved with a shared golden here and
 * across packages in 06-25). The block always ends in a newline. A passthrough
 * key can never override a schema-owned key.
 */
export function serializeTaskFrontmatter(
  frontmatter: TaskFrontmatter,
  passthrough: readonly (readonly [string, unknown])[] = [],
): string {
  const source = frontmatter as unknown as Record<string, unknown>;
  let out = "";
  for (const key of TASK_FRONTMATTER_KEY_ORDER) {
    const value = source[key];
    if (value === undefined) continue;
    if (key === "generatedBy") {
      out += dumpEntry(key, orderedGeneratedBy(value as GeneratedBy));
    } else if (key === "decision") {
      out += dumpEntry(key, orderedMap(value as object, TASK_DECISION_KEY_ORDER));
    } else {
      out += dumpEntry(key, value);
    }
  }
  const owned: ReadonlySet<string> = new Set(TASK_FRONTMATTER_KEY_ORDER);
  return out + serializePassthroughFrontmatter(passthrough.filter(([key]) => !owned.has(key)));
}

/** Rebuilds a nested map with its keys in a fixed order, dropping absent ones (YAML cannot dump `undefined`). */
function orderedMap(value: object, order: readonly string[]): Record<string, unknown> {
  const source = value as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of order) {
    const sub = source[key];
    if (sub !== undefined) ordered[key] = sub;
  }
  return ordered;
}
