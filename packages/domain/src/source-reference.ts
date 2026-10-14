import { z } from "zod";
import { hasDisallowedTextCharacter } from "./task-schema.js";

/**
 * The normalized source reference (plan 07-03; D-11, RSRCH-03, PRD 10.1,
 * research Pattern 4, threat T-07-07).
 *
 * Every piece of material a research report cites is described by exactly one
 * of these. The schema is strict and carries exactly the PRD fields; anything
 * the reader needs beyond them (the per-source sanitise counts) rides in a
 * separate `sourceHandling` key of the report, never in here.
 *
 * Three rules make the reference safe to decompose into paths and links:
 *
 * - the id is 32 lowercase hex characters (the service derives it as the first
 *   half of the SHA-256 of the canonical address), so it is safe as a file
 *   name and cannot express a separator, a dot or a traversal;
 * - the raw snapshot path is exactly `global/raw/<32 hex>.<8 hex>.md`, so a
 *   reference can never point outside the raw folder;
 * - exactly one address exists: an https `canonicalUrl` that the fetch stage
 *   built, or a `deepLink` with a reserved scheme for private sources.
 *   Model text never supplies either (RSRCH-08).
 *
 * This file is Node-free: it is reachable from the plugin's browser bundle.
 * Hashing happens in the service; this file only checks the SHAPE of a hash.
 */

/**
 * What kind of thing a source is. Milestone 1 produces only `feed-entry` and
 * `web-page`; the rest are reserved so adding a private source later changes
 * no schema. Append-only.
 */
export const SOURCE_TYPES = ["feed-entry", "web-page", "email", "note", "repository"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** The visible words for each source type; the reserved ones are placeholders until they occur. */
export const SOURCE_TYPE_DISPLAY: Readonly<Record<SourceType, string>> = {
  "feed-entry": "Feed entry",
  "web-page": "Web page",
  email: "Email",
  note: "Note",
  repository: "Repository",
};

/**
 * How private a source is (D-07). Only `public` occurs live in milestone 1;
 * `private` and `sensitive` exist in the schema and are exercised by fixtures.
 */
export const ACCESS_CLASSES = ["public", "private", "sensitive"] as const;
export type AccessClass = (typeof ACCESS_CLASSES)[number];

export interface AccessClassDisplay {
  readonly label: string;
  /** The `dd` help line beside the label (UI-SPEC "Access classification"). */
  readonly explanation: string;
}

export const ACCESS_CLASS_DISPLAY: Readonly<Record<AccessClass, AccessClassDisplay>> = {
  public: { label: "Public", explanation: "Fetched from a public web address." },
  private: {
    label: "Private",
    explanation: "Comes from your own vault or accounts. Stays on this Mac.",
  },
  sensitive: {
    label: "Sensitive",
    explanation: "Personal content. Stays on this Mac and is never sent to the summariser.",
  },
};

/**
 * The URI schemes a `deepLink` may use. Reserved for links into the owner's own
 * apps; anything else (`javascript:`, `file:`, `data:`, a web scheme) is refused.
 * Append-only.
 */
export const DEEP_LINK_SCHEMES = ["obsidian"] as const;

/** A source id: the first 32 hex characters of the SHA-256 of the canonical address. */
export const SOURCE_ID_PATTERN = /^[0-9a-f]{32}$/;

/** A SHA-256 content hash in lowercase hex. */
export const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The only vault path a snapshot may name: `global/raw/<32 hex>.<8 hex>.md`,
 * the id and the first eight characters of the content hash. A re-fetch with
 * unchanged content hits the same file; changed content makes a new one, so a
 * past report's `snapshotPath` and hash stay true.
 */
export const RAW_SNAPSHOT_PATH_PATTERN = /^global\/raw\/[0-9a-f]{32}\.[0-9a-f]{8}\.md$/;

/** How many leading hash characters close a raw snapshot's file name. */
export const RAW_SNAPSHOT_HASH_PREFIX_LENGTH = 8;

/**
 * The raw snapshot path for a source id and content hash.
 *
 * @throws RangeError when either argument is malformed. Both come from the
 * service, so this is a programming error, and refusing keeps an unchecked
 * value out of a path.
 */
export function rawSnapshotPathFor(id: string, contentHash: string): string {
  if (!SOURCE_ID_PATTERN.test(id)) throw new RangeError("a raw snapshot path needs a source id");
  if (!CONTENT_HASH_PATTERN.test(contentHash)) {
    throw new RangeError("a raw snapshot path needs a content hash");
  }
  return `global/raw/${id}.${contentHash.slice(0, RAW_SNAPSHOT_HASH_PREFIX_LENGTH)}.md`;
}

/**
 * One line of text with no control, format, line-separator or paragraph-separator
 * character (a newline would let one value become two frontmatter lines, and a
 * bidi override reorders what a reader sees). Not blank. Shared by every
 * research schema that stores a label or a sentence.
 */
export function plainLineText(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !hasDisallowedTextCharacter(value), {
      message: "must be one line with no control or invisible format characters",
    })
    .refine((value) => value.trim().length > 0, { message: "must not be blank" });
}

/** The longest address either kind may be. */
export const SOURCE_ADDRESS_MAX_LENGTH = 2048;

/**
 * An https address with a host and no user-info, no whitespace and no control or
 * invisible character. The WHATWG parser silently strips tabs and newlines, so
 * the raw string is checked as well as the parsed URL.
 */
export const HttpsUrlSchema = z
  .string()
  .min(1)
  .max(SOURCE_ADDRESS_MAX_LENGTH)
  .refine(
    (value) => {
      if (/\s/u.test(value) || hasDisallowedTextCharacter(value)) return false;
      try {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          url.hostname !== "" &&
          url.username === "" &&
          url.password === ""
        );
      } catch {
        return false;
      }
    },
    { message: "must be an https address with no user-info" },
  );

const DEEP_LINK_PATTERN = new RegExp(`^(?:${DEEP_LINK_SCHEMES.join("|")})://[^\\s]+$`, "u");

/** A link into one of the owner's own apps, with a reserved scheme and no whitespace or invisible character. */
export const DeepLinkSchema = z
  .string()
  .min(1)
  .max(SOURCE_ADDRESS_MAX_LENGTH)
  .refine((value) => DEEP_LINK_PATTERN.test(value) && !hasDisallowedTextCharacter(value), {
    message: "must be a link with a reserved app scheme",
  });

/** The eleven PRD 10.1 fields, in the order a writer emits them. */
export const SOURCE_REFERENCE_FIELDS = [
  "sourceType",
  "id",
  "title",
  "canonicalUrl",
  "deepLink",
  "author",
  "publishedAt",
  "retrievedAt",
  "contentHash",
  "snapshotPath",
  "accessClass",
] as const;

/**
 * One source, normalized. `author` and `publishedAt` are nullable (a feed need
 * not carry them) but present: `null` records "the source did not say", which a
 * missing key could not distinguish from an older schema. `contentHash` is the
 * SHA-256 of the canonical sanitised text before any Markdown escaping, which
 * is NOT the note-level `contentHash` the vault writer stamps over a whole body.
 */
export const SourceReferenceSchema = z
  .strictObject({
    sourceType: z.enum(SOURCE_TYPES),
    id: z.string().regex(SOURCE_ID_PATTERN),
    title: plainLineText(200),
    canonicalUrl: HttpsUrlSchema.optional(),
    deepLink: DeepLinkSchema.optional(),
    author: plainLineText(200).nullable(),
    publishedAt: z.iso.datetime().nullable(),
    retrievedAt: z.iso.datetime(),
    contentHash: z.string().regex(CONTENT_HASH_PATTERN),
    snapshotPath: z.string().regex(RAW_SNAPSHOT_PATH_PATTERN),
    accessClass: z.enum(ACCESS_CLASSES),
  })
  .refine((ref) => (ref.canonicalUrl === undefined) !== (ref.deepLink === undefined), {
    message: "exactly one of canonicalUrl and deepLink",
  });
export type SourceReference = z.infer<typeof SourceReferenceSchema>;
