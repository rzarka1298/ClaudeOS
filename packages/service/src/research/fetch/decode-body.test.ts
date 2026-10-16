import { describe, expect, it } from "vitest";
import { decodeBody } from "./decode-body.js";

const HIDDEN = "<p>ok</p><div hidden>SECRET</div>";

function utf16le(text: string, bom = true): Uint8Array {
  const body = Buffer.from(text, "utf16le");
  return bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body;
}

function utf16be(text: string, bom = true): Uint8Array {
  const le = Buffer.from(text, "utf16le");
  const be = Buffer.alloc(le.length);
  for (let i = 0; i < le.length; i += 2) {
    be[i] = le[i + 1] ?? 0;
    be[i + 1] = le[i] ?? 0;
  }
  return bom ? Buffer.concat([Buffer.from([0xfe, 0xff]), be]) : be;
}

const ascii = (text: string): Uint8Array => Buffer.from(text, "latin1");
const E_ACUTE = String.fromCharCode(0xe9);

describe("decodeBody: byte-order mark first", () => {
  it("reads a UTF-16LE page with a BOM as UTF-16, never as UTF-8", () => {
    const result = decodeBody(utf16le(HIDDEN), "text/html");
    expect(result).toEqual({ ok: true, text: HIDDEN, charset: "utf-16le" });
    // The UTF-8 reading would carry NULs between every character.
    const asUtf8 = new TextDecoder("utf-8").decode(utf16le(HIDDEN));
    expect(asUtf8).toContain("\u0000");
    expect(result.ok && result.text).not.toBe(asUtf8);
  });

  it("lets the BOM win over a Content-Type charset that disagrees", () => {
    const result = decodeBody(utf16le(HIDDEN), "text/html; charset=utf-8");
    expect(result.ok && result.text).toBe(HIDDEN);
  });

  it("reads UTF-16BE with a BOM", () => {
    const result = decodeBody(utf16be(HIDDEN), "text/html");
    expect(result.ok && result.text).toBe(HIDDEN);
  });

  it("strips a UTF-8 BOM", () => {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("<p>hi</p>", "utf8"),
    ]);
    const result = decodeBody(bytes, "text/html");
    expect(result).toEqual({ ok: true, text: "<p>hi</p>", charset: "utf-8" });
  });

  it("refuses a UTF-32LE BOM: it is read as UTF-16 and the NULs give it away", () => {
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe, 0x00, 0x00]),
      Buffer.from("<\u0000\u0000\u0000p\u0000\u0000\u0000", "latin1"),
    ]);
    expect(decodeBody(bytes, "text/html").ok).toBe(false);
  });
});

describe("decodeBody: Content-Type charset second", () => {
  it("decodes UTF-16LE named in the header when there is no BOM", () => {
    const result = decodeBody(utf16le(HIDDEN, false), "text/html; charset=utf-16le");
    expect(result.ok && result.text).toBe(HIDDEN);
  });

  it("accepts quoted, upper-case and spaced charset parameters", () => {
    for (const header of [
      'text/html; charset="utf-8"',
      "text/html;charset=UTF-8",
      "TEXT/HTML ; Charset = utf-8 ",
    ]) {
      const result = decodeBody(ascii("<p>x</p>"), header);
      expect(result.ok, header).toBe(true);
    }
  });

  it("decodes a legacy charset as a browser does", () => {
    const result = decodeBody(
      Buffer.from([0x3c, 0x70, 0x3e, 0xe9]),
      "text/html; charset=iso-8859-1",
    );
    expect(result.ok && result.text).toBe(`<p>${E_ACUTE}`);
  });

  it("prefers the header over a meta charset", () => {
    const page = '<meta charset="iso-8859-1"><p>x</p>';
    const result = decodeBody(ascii(page), "text/html; charset=utf-8");
    expect(result.ok && result.charset).toBe("utf-8");
  });

  it("refuses a label no browser knows, and UTF-7", () => {
    expect(decodeBody(ascii("<p>x</p>"), "text/html; charset=x-nonsense").ok).toBe(false);
    expect(decodeBody(ascii("+ADw-p+AD4-"), "text/html; charset=utf-7").ok).toBe(false);
  });

  it("refuses UTF-16 bytes that the header calls UTF-8 (a NUL in the decoded text)", () => {
    const result = decodeBody(utf16le(HIDDEN, false), "text/html; charset=utf-8");
    expect(result).toEqual({ ok: false });
  });

  it("does not refuse a stray invalid byte: it becomes a replacement character", () => {
    const result = decodeBody(Buffer.from([0x3c, 0x70, 0x3e, 0xff]), "text/html; charset=utf-8");
    expect(result.ok && result.text).toBe("<p>\ufffd");
  });
});

describe("decodeBody: meta charset third, then refuse", () => {
  it("reads a meta charset in the first 1,024 bytes", () => {
    const result = decodeBody(ascii('<!doctype html><meta charset="utf-8"><p>x</p>'), "text/html");
    expect(result).toEqual({
      ok: true,
      text: '<!doctype html><meta charset="utf-8"><p>x</p>',
      charset: "utf-8",
    });
  });

  it("reads the http-equiv form", () => {
    const page =
      '<meta http-equiv="Content-Type" content="text/html; charset=windows-1252"><p>x</p>';
    const result = decodeBody(ascii(page), "text/html");
    expect(result.ok && result.charset).toBe("windows-1252");
  });

  it("ignores a meta that starts after the first 1,024 bytes", () => {
    const page = `${" ".repeat(1100)}<meta charset="utf-8"><p>x</p>`;
    expect(decodeBody(ascii(page), "text/html")).toEqual({ ok: false });
  });

  it("ignores a meta inside a comment", () => {
    const page = '<!-- <meta charset="utf-8"> --><p>x</p>';
    expect(decodeBody(ascii(page), "text/html")).toEqual({ ok: false });
  });

  it("treats a meta that names UTF-16 for ASCII bytes as UTF-8, as browsers do", () => {
    const page = '<meta charset="utf-16"><p>x</p>';
    const result = decodeBody(ascii(page), "text/html");
    expect(result.ok && result.text).toBe(page);
    expect(result.ok && result.charset).toBe("utf-8");
  });

  it("refuses a page with no BOM, no charset and no meta", () => {
    expect(decodeBody(ascii("<p>x</p>"), "text/html")).toEqual({ ok: false });
    expect(decodeBody(ascii("<p>x</p>"), undefined)).toEqual({ ok: false });
  });

  it("refuses text/plain with no charset: there is no meta to read", () => {
    expect(decodeBody(ascii('<meta charset="utf-8"> text'), "text/plain")).toEqual({ ok: false });
    expect(decodeBody(ascii("text"), "text/plain; charset=utf-8").ok).toBe(true);
  });
});

describe("decodeBody: XML feeds use the XML declaration where a page uses meta", () => {
  it("reads the declared encoding", () => {
    const feed = '<?xml version="1.0" encoding="UTF-8"?><feed></feed>';
    expect(decodeBody(ascii(feed), "application/atom+xml")).toEqual({
      ok: true,
      text: feed,
      charset: "utf-8",
    });
    const single = "<?xml version='1.0' encoding='utf-8'?><rss></rss>";
    expect(decodeBody(ascii(single), "application/octet-stream").ok).toBe(true);
  });

  it("decodes a feed with no BOM, no charset and no declaration as UTF-8, the XML default", () => {
    for (const type of [
      "application/atom+xml",
      "application/xml",
      "text/xml",
      "application/rss+xml",
    ]) {
      const bare = decodeBody(ascii("<feed><title>x</title></feed>"), type);
      expect(bare.ok, type).toBe(true);
    }
    const bytes = new TextEncoder().encode("<feed><title>caf\u00e9 \u2014 x</title></feed>");
    const result = decodeBody(bytes, "application/atom+xml");
    expect(result).toEqual({
      ok: true,
      text: "<feed><title>caf\u00e9 \u2014 x</title></feed>",
      charset: "utf-8",
    });
  });

  it("decodes a feed whose declaration names no encoding as UTF-8", () => {
    const feed = '<?xml version="1.0"?><feed><title>caf\u00e9</title></feed>';
    const result = decodeBody(new TextEncoder().encode(feed), "application/xml");
    expect(result).toEqual({ ok: true, text: feed, charset: "utf-8" });
    const single = "<?xml version='1.0' standalone='yes'?><rss></rss>";
    expect(decodeBody(ascii(single), "text/xml").ok).toBe(true);
  });

  it("still refuses a UTF-16 feed with no mark and no declaration, by its decoded NULs", () => {
    const wide = Uint8Array.from(
      [..."<feed></feed>"].flatMap((character) => [character.charCodeAt(0), 0]),
    );
    expect(decodeBody(wide, "application/atom+xml")).toEqual({ ok: false });
  });

  it("does not extend the UTF-8 default to a page, XHTML or an unknown type", () => {
    expect(decodeBody(ascii("<p>x</p>"), "text/html")).toEqual({ ok: false });
    expect(decodeBody(ascii("<p>x</p>"), "application/xhtml+xml")).toEqual({ ok: false });
    expect(decodeBody(ascii("<feed></feed>"), "text/plain")).toEqual({ ok: false });
    expect(decodeBody(ascii("<feed></feed>"), undefined)).toEqual({ ok: false });
  });

  it("refuses an ASCII feed that declares UTF-16", () => {
    const feed = '<?xml version="1.0" encoding="UTF-16"?><feed></feed>';
    expect(decodeBody(ascii(feed), "application/atom+xml")).toEqual({ ok: false });
  });

  it("takes the header charset before the declaration", () => {
    const feed = '<?xml version="1.0" encoding="iso-8859-1"?><feed></feed>';
    const result = decodeBody(ascii(feed), "application/atom+xml; charset=utf-8");
    expect(result.ok && result.charset).toBe("utf-8");
  });
});

describe("decodeBody: a NUL in the decoded text is never accepted", () => {
  it("refuses a NUL even when the charset is plausible", () => {
    expect(decodeBody(ascii("<p>a\u0000b</p>"), "text/html; charset=utf-8")).toEqual({ ok: false });
  });
});
