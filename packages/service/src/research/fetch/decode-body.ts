import { META_PRESCAN_BYTES } from "./limits.js";

/**
 * Decode fetched bytes the way a browser does, or refuse (plan 07-09, wave 2 review MAJOR 4).
 *
 * Order: byte-order mark, then the Content-Type charset, then a meta charset in the first 1,024
 * bytes (pages) or the XML declaration (feeds, the XML analogue of meta), otherwise REFUSE. A page
 * with a UTF-16 byte-order mark is never read as UTF-8: read that way its markup would become
 * literal text with NULs between the letters and a hidden block would pass the sanitiser as
 * visible text. A decoded NUL is also refused outright, which catches UTF-16 or UTF-32 served under
 * a UTF-8 label with no mark.
 */

export type DecodeResult =
  | { readonly ok: true; readonly text: string; readonly charset: string }
  | { readonly ok: false };

const REFUSED: DecodeResult = { ok: false };
const NUL = String.fromCharCode(0);

const HTML_TYPES: ReadonlySet<string> = new Set(["text/html", "application/xhtml+xml"]);

function mediaTypeOf(contentType: string | undefined): string | undefined {
  const type = contentType?.split(";")[0]?.trim().toLowerCase();
  return type === undefined || type === "" ? undefined : type;
}

function isXmlType(type: string | undefined): boolean {
  if (type === undefined) return false;
  return type === "application/octet-stream" || type.endsWith("/xml") || type.endsWith("+xml");
}

function bomEncoding(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  return undefined;
}

function headerCharset(contentType: string | undefined): string | undefined {
  if (contentType === undefined) return undefined;
  for (const parameter of contentType.split(";").slice(1)) {
    const separator = parameter.indexOf("=");
    if (separator < 0) continue;
    if (parameter.slice(0, separator).trim().toLowerCase() !== "charset") continue;
    const value = parameter
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, "")
      .trim();
    return value === "" ? undefined : value;
  }
  return undefined;
}

function metaCharset(bytes: Uint8Array): string | undefined {
  const head = Buffer.from(bytes.subarray(0, META_PRESCAN_BYTES)).toString("latin1");
  const withoutComments = head.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  for (const tag of withoutComments.match(/<meta\b[^>]*>/gi) ?? []) {
    const found = /charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/;]+))/i.exec(tag);
    const label = found?.[1] ?? found?.[2] ?? found?.[3];
    if (label !== undefined && label.trim() !== "") return label.trim();
  }
  return undefined;
}

function xmlDeclarationCharset(bytes: Uint8Array): string | undefined {
  const head = Buffer.from(bytes.subarray(0, 256)).toString("latin1");
  const found = /^\s*<\?xml\b[^>]*?\sencoding\s*=\s*(["'])([A-Za-z][A-Za-z0-9._-]*)\1/.exec(head);
  return found?.[2];
}

/** The canonical WHATWG name for a label, or undefined when no browser would know it. */
function canonicalEncoding(label: string): string | undefined {
  try {
    const name = new TextDecoder(label).encoding;
    return name === "replacement" ? undefined : name;
  } catch {
    return undefined;
  }
}

function isUtf16(name: string): boolean {
  return name === "utf-16le" || name === "utf-16be";
}

function finish(bytes: Uint8Array, encoding: string): DecodeResult {
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: false, ignoreBOM: false }).decode(bytes);
  } catch {
    return REFUSED;
  }
  if (text.includes(NUL)) return REFUSED;
  return { ok: true, text, charset: encoding };
}

export function decodeBody(bytes: Uint8Array, contentType: string | undefined): DecodeResult {
  const mark = bomEncoding(bytes);
  if (mark !== undefined) return finish(bytes, mark);

  const fromHeader = headerCharset(contentType);
  if (fromHeader !== undefined) {
    const name = canonicalEncoding(fromHeader);
    return name === undefined ? REFUSED : finish(bytes, name);
  }

  const type = mediaTypeOf(contentType);
  if (isXmlType(type)) {
    const declared = xmlDeclarationCharset(bytes);
    if (declared !== undefined) {
      const name = canonicalEncoding(declared);
      // ASCII bytes that declare UTF-16 contradict themselves.
      if (name === undefined || isUtf16(name)) return REFUSED;
      return finish(bytes, name);
    }
  }
  if (type !== undefined && HTML_TYPES.has(type)) {
    const label = metaCharset(bytes);
    if (label !== undefined) {
      const name = canonicalEncoding(label);
      if (name === undefined) return REFUSED;
      // The prescan read ASCII, so a UTF-16 claim is read as UTF-8, as browsers do.
      return finish(bytes, isUtf16(name) ? "utf-8" : name);
    }
  }
  return REFUSED;
}
