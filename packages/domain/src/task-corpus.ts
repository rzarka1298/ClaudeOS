/**
 * Shared hostile test data for every package that parses, writes, indexes,
 * serves or renders a task note (plan 06-05; research spike S1 and Wave 0;
 * threats T-06-19, T-06-21, T-06-25). It is plain data with no logic, exported
 * from the full domain barrel only: it is not product code, so no browser
 * bundle carries it.
 *
 * Every invisible or non-ASCII character below is written as an escape
 * sequence. A raw bidi override or zero-width character in a source file is
 * itself the attack this corpus exists to model, and it would be invisible in
 * review. A test scans this file's source for any byte outside printable ASCII.
 */

interface HostileEntry {
  readonly title: string;
  /**
   * True when the entry is valid single-line title text, so the title schema
   * accepts it and a writer must round-trip it byte for byte. False when the
   * schema must refuse it (control, format, separator, blank or over-long).
   */
  readonly valid: boolean;
}

const ok = (title: string): HostileEntry => ({ title, valid: true });
const bad = (title: string): HostileEntry => ({ title, valid: false });

const HOSTILE_ENTRIES: readonly HostileEntry[] = [
  // YAML 1.1 words that a loose loader turns into booleans or null.
  ok("yes"),
  ok("no"),
  ok("on"),
  ok("off"),
  ok("Yes"),
  ok("NO"),
  ok("y"),
  ok("n"),
  ok("null"),
  ok("Null"),
  ok("~"),
  ok("true"),
  ok("false"),
  ok("True"),
  ok("FALSE"),
  // Numbers: decimal, float, exponent, hex, octal, binary, sexagesimal, infinity.
  ok("123"),
  ok("-1"),
  ok("3.14"),
  ok("1e3"),
  ok("1_000"),
  ok(".inf"),
  ok("-.inf"),
  ok(".nan"),
  ok("0x1F"),
  ok("0o17"),
  ok("017"),
  ok("0b101"),
  ok("12:30:45"),
  ok("1:20"),
  // Dates and timestamps: a loose loader turns these into Date objects.
  ok("2026-10-04"),
  ok("2026-10-04T12:00:00Z"),
  ok("2026-10-04 12:00:00 +01:00"),
  // Leading indicator characters.
  ok("- item"),
  ok("? key"),
  ok(": value"),
  ok(", comma"),
  ok("[flow"),
  ok("]close"),
  ok("{flow"),
  ok("}close"),
  ok("#comment"),
  ok("&anchor"),
  ok("*alias"),
  ok("!tag"),
  ok("!!str forced"),
  ok("|literal"),
  ok(">folded"),
  ok("'single"),
  ok('"double'),
  ok("%directive"),
  ok("@at"),
  ok("`tick"),
  // Colons, hashes and quotes inside the text.
  ok("a: b"),
  ok("key: value: nested"),
  ok("http://example.test/path?x=1#frag"),
  ok("text # not a comment"),
  ok("it's"),
  ok('say "hi"'),
  ok("both ' and \""),
  ok("back\\slash"),
  ok("literal \\n and \\t"),
  // Anchors, aliases, tags and merge keys.
  ok("&a b"),
  ok("<<: *base"),
  ok("!!python/object:os.system x"),
  ok("!!js/function x"),
  // Document markers and the JavaScript front-matter marker.
  ok("---"),
  ok("..."),
  ok("--- text"),
  ok("---js"),
  ok("---yaml"),
  // Whitespace at the edges and inside; a blank title is refused.
  ok(" leading space"),
  ok("trailing space "),
  ok("double  space"),
  ok("a\u00A0b"),
  bad("   "),
  bad("\u00A0"),
  // Markdown, HTML and script text: stored and shown as literal text only.
  ok("<script>alert(1)</script>"),
  ok("<img src=x onerror=alert(1)>"),
  ok("[link](javascript:alert(1))"),
  ok("![img](x)"),
  ok("**bold** and `code`"),
  // Injection-shaped text for the path, shell and SQL boundaries.
  ok("../../etc/passwd"),
  ok("a/b\\c"),
  // biome-ignore lint/suspicious/noTemplateCurlyInString: hostile data, deliberately not a template
  ok("${process.env.HOME}"),
  ok("{{template}}"),
  ok("$(rm -rf /)"),
  ok("'; DROP TABLE tasks;--"),
  // International and normalisation cases that are valid text.
  ok("caf\u00E9"),
  ok("cafe\u0301"),
  ok("\u65E5\u672C\u8A9E"),
  ok("\u05E9\u05DC\u05D5\u05DD"),
  ok("\u0645\u0631\u062D\u0628\u0627"),
  ok("emoji \u{1F600}"),
  ok("variation \u2764\uFE0F"),
  ok("hangul filler \u3164 here"),
  ok("braille blank \u2800 here"),
  ok("unassigned \u0378 here"),
  // Length: 200 is the last accepted length.
  ok("z".repeat(200)),
  bad("y".repeat(201)),
  bad("x".repeat(300)),
  // Bidi overrides, isolates and marks: format characters, refused.
  bad("a\u202Ab"),
  bad("a\u202Bb"),
  bad("a\u202Cb"),
  bad("a\u202Db"),
  bad("a\u202Eb"),
  bad("a\u2066b"),
  bad("a\u2067b"),
  bad("a\u2068b"),
  bad("a\u2069b"),
  bad("a\u200Eb"),
  bad("a\u200Fb"),
  bad("a\u061Cb"),
  // Zero-width, joiner, soft hyphen, byte-order mark and tag characters: format, refused.
  bad("a\u200Bb"),
  bad("a\u200Cb"),
  bad("a\u200Db"),
  bad("a\u2060b"),
  bad("a\uFEFFb"),
  bad("a\u00ADb"),
  bad("a\u{E0041}b"),
  bad("family \u{1F468}\u200D\u{1F469}"),
  // Control and separator characters: a second line would forge a frontmatter key.
  bad("line one\nline two"),
  bad("carriage\rreturn"),
  bad("tab\tinside"),
  bad("nul\0inside"),
  bad("escape\u001Binside"),
  bad("delete\u007Finside"),
  bad("next line\u0085inside"),
  bad("line sep\u2028inside"),
  bad("paragraph sep\u2029inside"),
  bad("title\n---\nstatus: done"),
];

/** Every hostile title, valid or not. Writers iterate it; readers expect the schema to decide. */
export const HOSTILE_TASK_TITLES: readonly string[] = HOSTILE_ENTRIES.map((entry) => entry.title);

/** The entries that are valid single-line text: these must round-trip byte for byte. */
export const VALID_HOSTILE_TASK_TITLES: readonly string[] = HOSTILE_ENTRIES.filter(
  (entry) => entry.valid,
).map((entry) => entry.title);

/** What loading and validating a note variant is expected to give (CORE_SCHEMA load, then the task schema). */
export type YamlNoteOutcome = "valid" | "missing-id" | "invalid-field";

/** One Obsidian-style task note, as it might sit on disk after a hand edit, a sync or an automation. */
export interface YamlNoteVariant {
  readonly name: string;
  /** File name inside a tasks folder. */
  readonly fileName: string;
  /** The note id the file carries, or null when it carries none. */
  readonly id: string | null;
  readonly outcome: YamlNoteOutcome;
  /** The whole file, delimiters and body included. */
  readonly text: string;
  readonly note: string;
}

/** A distinct, well-formed note id per variant, so one vault can hold every variant at once. */
const idOf = (n: number): string => `v${n.toString(36).padStart(8, "0")}0123456789abcdef`;
const ID_DUP = "dddddddddd0123456789ddddd";

interface VariantOptions {
  readonly id?: string | null;
  readonly created?: string;
  readonly title?: string;
  readonly status?: string;
  readonly due?: string | null;
  readonly tags?: readonly string[] | "flow" | "block";
  readonly quote?: "single" | "double";
  readonly extra?: readonly string[];
  readonly eol?: "\n" | "\r\n";
  readonly body?: string;
}

function variantText(options: VariantOptions = {}): string {
  const eol = options.eol ?? "\n";
  const q = options.quote === "double" ? '"' : options.quote === "single" ? "'" : "";
  const quoted = (value: string): string => `${q}${value}${q}`;
  const id = options.id === undefined ? idOf(0) : options.id;
  const lines: string[] = [];
  if (id !== null) lines.push(`id: ${id}`);
  lines.push(
    "scope: global",
    "stage: capture",
    `created: ${options.created ?? "'2026-10-05T12:00:00Z'"}`,
    `updated: ${options.created ?? "'2026-10-05T12:00:00Z'"}`,
    "generatedBy: {}",
    "aiGenerated: false",
    "sources: []",
    "confidence: unverified",
    "lastReviewed: null",
    "type: task",
    `title: ${options.title ?? quoted("Draft the weekly review")}`,
    `status: ${options.status ?? quoted("inbox")}`,
  );
  if (options.due !== undefined && options.due !== null) lines.push(`due: ${options.due}`);
  lines.push("sourceType: manual", "dependencies: []");
  if (options.tags === "flow") {
    lines.push("tags: [work, review]");
  } else if (options.tags === "block") {
    lines.push("tags:", "  - work", "  - review");
  } else if (Array.isArray(options.tags)) {
    lines.push(`tags: [${options.tags.join(", ")}]`);
  } else {
    lines.push("tags: []");
  }
  for (const extra of options.extra ?? []) lines.push(extra);
  return `---${eol}${lines.join(eol)}${eol}---${eol}${options.body ?? "Notes for the review.\n"}`;
}

/**
 * Obsidian-style forms the readers and writers must all agree on. The service
 * and the plugin load task notes with the YAML core schema, so an unquoted
 * date is a string, and a hand-edited unquoted sexagesimal or hex title is a
 * number that the title schema refuses: it lands in the attention list and is
 * never coerced or repaired.
 */
export const YAML_NOTE_VARIANTS: readonly YamlNoteVariant[] = [
  {
    name: "canonical",
    fileName: "draft-the-weekly-review-23456789.md",
    id: idOf(1),
    outcome: "valid",
    text: variantText({ id: idOf(1) }),
    note: "As the service writes it.",
  },
  {
    name: "unquoted-date",
    fileName: "unquoted-date-3456789a.md",
    id: idOf(2),
    outcome: "valid",
    text: variantText({
      id: idOf(2),
      created: "2026-10-05T12:00:00Z",
      due: "2026-10-09",
    }),
    note: "Obsidian writes dates unquoted. Under the core schema they stay strings, never Date objects.",
  },
  {
    name: "double-quoted-strings",
    fileName: "double-quoted-456789ab.md",
    id: idOf(3),
    outcome: "valid",
    text: variantText({ id: idOf(3), quote: "double" }),
    note: "Obsidian's property editor double-quotes strings.",
  },
  {
    name: "flow-style-tags",
    fileName: "flow-style-tags-56789abc.md",
    id: idOf(4),
    outcome: "valid",
    text: variantText({ id: idOf(4), tags: "flow" }),
    note: "Tags as a flow sequence.",
  },
  {
    name: "block-style-tags",
    fileName: "block-style-tags-6789abcd.md",
    id: idOf(5),
    outcome: "valid",
    text: variantText({ id: idOf(5), tags: "block" }),
    note: "Tags as a block sequence, as Obsidian's property editor writes them.",
  },
  {
    name: "missing-id",
    fileName: "missing-id-789abcde.md",
    id: null,
    outcome: "missing-id",
    text: variantText({ id: null }),
    note: "A note a person created in the tasks folder with no id. It is listed, never given one.",
  },
  {
    name: "duplicate-id-first",
    fileName: "copy-of-a-task-89abcdef.md",
    id: ID_DUP,
    outcome: "valid",
    text: variantText({ id: ID_DUP }),
    note: "One of two notes sharing an id, as a file copy produces. Neither is indexed.",
  },
  {
    name: "duplicate-id-second",
    fileName: "copy-of-a-task-copy-9abcdefg.md",
    id: ID_DUP,
    outcome: "valid",
    text: variantText({ id: ID_DUP }),
    note: "The other copy.",
  },
  {
    name: "unquoted-yes-title",
    fileName: "unquoted-yes-abcdefgh.md",
    id: idOf(9),
    outcome: "valid",
    text: variantText({ id: idOf(9), title: "yes" }),
    note: "Under the core schema the word stays a string.",
  },
  {
    name: "unquoted-sexagesimal-title",
    fileName: "unquoted-time-bcdefghi.md",
    id: idOf(10),
    outcome: "invalid-field",
    text: variantText({ id: idOf(10), title: "12:30:45" }),
    note: "Loads as the number 45045. The title schema refuses it; it is never coerced.",
  },
  {
    name: "crlf-line-endings",
    fileName: "crlf-endings-cdefghij.md",
    id: idOf(11),
    outcome: "valid",
    text: variantText({ id: idOf(11), eol: "\r\n" }),
    note: "Windows line endings from a synced vault.",
  },
  {
    name: "unknown-keys",
    fileName: "unknown-keys-defghijk.md",
    id: idOf(12),
    outcome: "valid",
    text: variantText({
      id: idOf(12),
      extra: ["cssclasses: [wide]", "aliases: [weekly review]", "rating: 4"],
    }),
    note: "Keys other tools add. The schema ignores them; the task writer keeps them after its own keys.",
  },
  {
    name: "empty-body",
    fileName: "empty-body-efghijkl.md",
    id: idOf(13),
    outcome: "valid",
    text: variantText({ id: idOf(13), body: "" }),
    note: "A task with no description.",
  },
];
