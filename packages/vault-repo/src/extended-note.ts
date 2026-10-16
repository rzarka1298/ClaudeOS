import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { GENERATED_BY_KEY_ORDER, type GeneratedBy } from "@ccc/domain";
import yaml from "js-yaml";
import { assertPlainYamlDelimiter, parseWithYamlEngine } from "./frontmatter.js";
import { plainDateKeys } from "./task-note.js";
import { assertScopedWrite } from "./workspace-scope.js";

/**
 * The machinery the three research note writers share (plan 07-08; D-14, research Pattern 5).
 *
 * `task-note.ts` is the pattern: closed refusal reasons, a size check before any parse, the
 * plain-YAML delimiter check, js-yaml's CORE schema, a bound on what aliases can expand to, the
 * owned-keys passthrough, and a serialiser that dumps one key at a time in a fixed order. The
 * report, the raw snapshot and the wiki note each need all of it, so it lives here once. Nothing
 * here knows a note shape: the callers pass the schema, the caps and the key orders.
 *
 * Every refusal carries a fixed reason code and a constant message. None quotes the file, so an
 * attention list built from them never echoes note text.
 */

/** Why a research note was refused or could not be written. Each code is fixed. */
export type ExtendedNoteReason =
  | "too-large"
  | "frontmatter-too-large"
  | "refused-delimiter"
  | "invalid-yaml"
  | "missing-id"
  | "invalid-frontmatter"
  | "invalid-path"
  | "invalid-field"
  | "missing"
  | "existing-unreadable";

/** Base class of every refusal the research note writers raise. */
export class ExtendedNoteError extends Error {
  readonly reason: ExtendedNoteReason;
  readonly issues: readonly unknown[];

  constructor(reason: ExtendedNoteReason, message: string, issues: readonly unknown[] = []) {
    super(message);
    this.name = "ExtendedNoteError";
    this.reason = reason;
    this.issues = issues;
  }
}

/** Builds the module's own error class for a reason. */
export type ExtendedNoteFail = (
  reason: ExtendedNoteReason,
  issues?: readonly unknown[],
) => ExtendedNoteError;

/** The part of a zod schema these helpers use, so this package needs no zod dependency of its own. */
export interface FrontmatterSchema<T> {
  safeParse(
    data: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: readonly unknown[] } };
}

/**
 * The most nodes a loaded frontmatter value may expand to when every alias is followed
 * (T-06-26): a few kilobytes of nested aliases load instantly and then expand to hundreds of
 * megabytes the first time anything walks them. A real report has a few thousand nodes.
 */
const MAX_EXPANDED_NODES = 50_000;

const EXTENDED_YAML_ENGINE = {
  parse: (input: string): object =>
    (yaml.safeLoad(input, { schema: yaml.CORE_SCHEMA }) ?? {}) as object,
  stringify: (data: object): string => yaml.safeDump(data, { noRefs: true }),
};

/**
 * Bytes of the frontmatter block, measured WITHOUT parsing it. The closing delimiter is found no
 * later than gray-matter finds it, so this can only over-measure, never let an oversized block
 * through.
 */
export function frontmatterBlockBytes(raw: string): number {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (!text.startsWith("---")) return 0;
  const firstLineEnd = text.indexOf("\n");
  if (firstLineEnd === -1) return 0;
  const rest = text.slice(firstLineEnd + 1);
  const close = /(^|\n)---/.exec(rest);
  const block = close === null ? rest : rest.slice(0, close.index);
  return Buffer.byteLength(block, "utf8");
}

/** True when `value`, with every alias followed, has at most {@link MAX_EXPANDED_NODES} nodes. */
function withinExpansionBound(value: unknown): boolean {
  const stack: unknown[] = [value];
  let queued = 1;
  while (stack.length > 0) {
    const current = stack.pop();
    let children: readonly unknown[] = [];
    if (Array.isArray(current)) children = current;
    else if (typeof current === "object" && current !== null) children = Object.values(current);
    queued += children.length;
    if (queued > MAX_EXPANDED_NODES) return false;
    for (const item of children) stack.push(item);
  }
  return true;
}

function isPlainMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text between the opening and closing `---` lines (empty when there is none). */
function frontmatterBlock(raw: string): string {
  const end = raw.indexOf("\n---", 4);
  return end === -1 ? "" : raw.slice(4, end + 1);
}

/** A research note as it exists on disk. */
export interface ParsedExtendedNote<T> {
  readonly frontmatter: T;
  /** Everything after the closing delimiter, byte for byte. */
  readonly body: string;
  /** Keys the schema does not own, in read order, so a rewrite keeps them. */
  readonly passthrough: Record<string, unknown>;
  /** Keys whose source value was an unquoted `YYYY-MM-DD`; a rewrite keeps them unquoted. */
  readonly plainDateKeys: ReadonlySet<string>;
}

export interface ParseSpec<T> {
  readonly fileMaxBytes: number;
  readonly frontmatterMaxBytes: number;
  readonly schema: FrontmatterSchema<T>;
  readonly ownedKeys: ReadonlySet<string>;
  readonly fail: ExtendedNoteFail;
}

/**
 * Parses one research note, refusing rather than repairing. Order matters: whole-file and
 * frontmatter size limits first (before any YAML is loaded), then the delimiter (a `---js`
 * opening is gray-matter's `eval` engine), then the load with the core schema, then the alias
 * bound, then the schema. A note with no id is reported as such; no id is minted here.
 *
 * @throws the module's own error (built by `spec.fail`) for every refusal.
 */
export function parseExtendedNote<T>(raw: string, spec: ParseSpec<T>): ParsedExtendedNote<T> {
  if (Buffer.byteLength(raw, "utf8") > spec.fileMaxBytes) throw spec.fail("too-large");
  try {
    assertPlainYamlDelimiter(raw);
  } catch {
    throw spec.fail("refused-delimiter");
  }
  if (frontmatterBlockBytes(raw) > spec.frontmatterMaxBytes) {
    throw spec.fail("frontmatter-too-large");
  }

  let data: unknown;
  let body: string;
  try {
    const parsed = parseWithYamlEngine(raw, EXTENDED_YAML_ENGINE);
    data = parsed.data;
    body = parsed.content;
  } catch {
    throw spec.fail("invalid-yaml");
  }

  if (!isPlainMap(data)) throw spec.fail("invalid-frontmatter");
  if (!withinExpansionBound(data)) throw spec.fail("frontmatter-too-large");
  if (data.id === undefined || data.id === null || data.id === "") throw spec.fail("missing-id");

  const result = spec.schema.safeParse(data);
  if (!result.success) throw spec.fail("invalid-frontmatter", result.error.issues);

  // defineProperty rather than assignment, so a key spelled `__proto__` is data, not a prototype swap.
  const passthrough: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (spec.ownedKeys.has(key)) continue;
    Object.defineProperty(passthrough, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return {
    frontmatter: result.data,
    body,
    passthrough,
    plainDateKeys: plainDateKeys(frontmatterBlock(raw)),
  };
}

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Reads a vault file through one descriptor, so nothing here can block on a special file or be
 * redirected between the check and the read. The file is opened without following a link at the
 * final component and without waiting for a writer (a FIFO opens at once instead of hanging the
 * process); the descriptor must be a regular file; the cap is enforced on the bytes actually read,
 * so a file that grew after the size check is still refused.
 *
 * @throws the module's own error: `missing` when the file is not there, `too-large` over the cap,
 *   `existing-unreadable` for a special file, a link, or any other failure to read it.
 */
export function readBoundedFile(
  absolutePath: string,
  fileMaxBytes: number,
  fail: ExtendedNoteFail,
): string {
  let fd: number;
  try {
    fd = openSync(absolutePath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (error) {
    throw fail(
      (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "existing-unreadable",
    );
  }
  let outcome: { text: string } | { reason: ExtendedNoteReason };
  try {
    outcome = readDescriptor(fd, fileMaxBytes);
  } catch {
    outcome = { reason: "existing-unreadable" };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // A descriptor that cannot be closed changes nothing the caller can act on.
    }
  }
  if ("reason" in outcome) throw fail(outcome.reason);
  return outcome.text;
}

function readDescriptor(
  fd: number,
  fileMaxBytes: number,
): { text: string } | { reason: ExtendedNoteReason } {
  const stat = fstatSync(fd);
  if (!stat.isFile()) return { reason: "existing-unreadable" };
  if (stat.size > fileMaxBytes) return { reason: "too-large" };
  const chunks: Buffer[] = [];
  let total = 0;
  const buffer = Buffer.alloc(READ_CHUNK_BYTES);
  for (;;) {
    const read = readSync(fd, buffer, 0, READ_CHUNK_BYTES, null);
    if (read === 0) break;
    total += read;
    if (total > fileMaxBytes) return { reason: "too-large" };
    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
  return { text: Buffer.concat(chunks).toString("utf8") };
}

/**
 * Checks that a vault-relative path has the exact shape a writer would have produced, then
 * resolves it through the scope guard (containment with symlinks resolved; the global scope never
 * reaches into `workspaces/`).
 *
 * @throws `invalid-path` for a path of the wrong shape; the scope error when it resolves outside
 *   the global scope.
 */
export function resolveGlobalNotePath(
  vaultRoot: string,
  relativePath: string,
  shape: RegExp,
  fail: ExtendedNoteFail,
): string {
  if (!shape.test(relativePath)) throw fail("invalid-path");
  return assertScopedWrite(join(vaultRoot, ...relativePath.split("/")), "global", vaultRoot);
}

/** Rebuilds a map with its keys in a fixed order, dropping absent ones (YAML cannot dump `undefined`). */
export function orderedMap(value: unknown, order: readonly string[]): Record<string, unknown> {
  const source = value as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of order) {
    const sub = source[key];
    if (sub !== undefined) ordered[key] = sub;
  }
  return ordered;
}

/** Orders every map of a list with one key order. */
export function orderedList(value: unknown, order: readonly string[]): unknown[] {
  return (value as readonly unknown[]).map((entry) => orderedMap(entry, order));
}

/** The fixed order of the nested `generatedBy` map. */
export function orderedGeneratedBy(value: unknown): Record<string, unknown> {
  return orderedMap(value as GeneratedBy, GENERATED_BY_KEY_ORDER);
}

const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One `key: value` entry dumped on its own, so key order belongs to the loops and not to a YAML option. */
function dumpEntry(key: string, value: unknown, plainDates: ReadonlySet<string>): string {
  if (plainDates.has(key) && typeof value === "string" && PLAIN_DATE.test(value)) {
    return `${key}: ${value}\n`;
  }
  return yaml.safeDump({ [key]: value }, { noRefs: true });
}

export interface StringifySpec {
  /** The schema-owned keys in their on-disk order. */
  readonly keyOrder: readonly string[];
  /** Per-key rewriters that put a nested value in its own fixed order. */
  readonly nested: Readonly<Record<string, (value: unknown) => unknown>>;
}

/**
 * Serialises a research note: the schema-owned keys in `spec.keyOrder` (nested values in their
 * own fixed orders), then the passthrough keys in the order they were read. Each key is dumped on
 * its own and the results concatenated, so a note written twice from the same fields has the same
 * bytes. The body follows the closing delimiter verbatim; it is concatenated, never handed to a
 * parser, so a body that starts with a delimiter or a language tag is only ever text. A
 * passthrough key can never override a schema-owned key.
 */
export function stringifyExtendedNote(
  frontmatter: object,
  body: string,
  spec: StringifySpec,
  passthrough: Readonly<Record<string, unknown>> = {},
  plainDates: ReadonlySet<string> = new Set(),
): string {
  const source = frontmatter as Record<string, unknown>;
  const owned = new Set(spec.keyOrder);
  let block = "";
  for (const key of spec.keyOrder) {
    const value = source[key];
    if (value === undefined) continue;
    const rewrite = spec.nested[key];
    block += dumpEntry(key, rewrite === undefined ? value : rewrite(value), plainDates);
  }
  for (const [key, value] of Object.entries(passthrough)) {
    if (value === undefined || owned.has(key)) continue;
    block += dumpEntry(key, value, plainDates);
  }
  return `---\n${block}---\n${body}`;
}

/** SHA-256 of a string's UTF-8 bytes, in lowercase hex. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
