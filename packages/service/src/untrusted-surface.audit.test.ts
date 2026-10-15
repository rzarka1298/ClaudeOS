// Wave 1+2 test audit for plan 07-02, truth 5: "the summariser module declares only a
// text-in/text-out TextTransport port and summarizeUntrusted; its only input is delimited text
// plus source ids and its only output is a text value; it holds no credential, file handle,
// network client or tool declaration". The executor's tests prove the round trip; this file pins
// the SURFACE, so a field or an export added later has to be justified in review.
//
// It lives beside the nested project, not inside it: the folder compiles with `types: []` and
// cannot name the Node file functions this test uses to read the module's own source.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as untrusted from "./untrusted/index.js";

const FOLDER = fileURLToPath(new URL("./untrusted/", import.meta.url));
const ID_A = "0123456789abcdef0123456789abcdef";
const ID_B = "fedcba9876543210fedcba9876543210";

interface Recorded {
  readonly request: object;
}

function recordingTransport(): { transport: untrusted.TextTransport; seen: Recorded[] } {
  const seen: Recorded[] = [];
  return {
    seen,
    transport: {
      async complete(request) {
        seen.push({ request });
        return "ok";
      },
    },
  };
}

describe("07-02 truth 5: the summariser's surface is a port and one function", () => {
  it("exports exactly summarizeUntrusted and UntrustedInputError at run time", () => {
    expect(Object.keys(untrusted).sort()).toEqual(["UntrustedInputError", "summarizeUntrusted"]);
  });

  it("hands the transport a request of exactly two string fields, instructions and input", async () => {
    const { transport, seen } = recordingTransport();
    await untrusted.summarizeUntrusted(
      { delimitedContent: "<<<SRC>>>", sourceIds: [ID_A] },
      transport,
    );
    expect(seen).toHaveLength(1);
    const request = seen[0]?.request as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual(["input", "instructions"]);
    expect(typeof request.instructions).toBe("string");
    expect(typeof request.input).toBe("string");
    expect(Object.getOwnPropertySymbols(request)).toEqual([]);
  });

  it("puts the delimited content first, verbatim, and the source id line after it in input order", async () => {
    const { transport, seen } = recordingTransport();
    const delimitedContent = "line one\nline two with  spacing\n";
    await untrusted.summarizeUntrusted({ delimitedContent, sourceIds: [ID_B, ID_A] }, transport);
    const input = (seen[0]?.request as { input?: string } | undefined)?.input ?? "";
    expect(input.startsWith(delimitedContent)).toBe(true);
    const tail = input.slice(delimitedContent.length);
    expect(tail).toBe(`\nSource IDs: ${ID_B}, ${ID_A}`);
  });

  it("returns an object with only a text field, even when the transport returns a lookalike", async () => {
    const lookalike = { toString: () => "x", tools: ["write"] } as unknown as string;
    const transport: untrusted.TextTransport = { complete: async () => lookalike };
    const result = await untrusted.summarizeUntrusted(
      { delimitedContent: "x", sourceIds: [ID_A] },
      transport,
    );
    expect(Object.keys(result)).toEqual(["text"]);
  });

  it("refuses a bad id wherever it sits in the list, with the typed error and a stable code", async () => {
    const { transport, seen } = recordingTransport();
    for (const sourceIds of [
      [ID_A, "nope"],
      ["nope", ID_A],
      [ID_A, ID_B, ID_A.toUpperCase()],
    ]) {
      await expect(
        untrusted.summarizeUntrusted({ delimitedContent: "x", sourceIds }, transport),
      ).rejects.toMatchObject({ name: "UntrustedInputError", code: "invalid-source-id" });
    }
    await expect(
      untrusted.summarizeUntrusted({ delimitedContent: "x", sourceIds: [] }, transport),
    ).rejects.toMatchObject({ name: "UntrustedInputError", code: "no-source-ids" });
    expect(seen).toHaveLength(0);
  });
});

/** Source with comments and string, template and regular-expression literals removed. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g, '""');
}

// Words that would mean the module holds a credential, a file handle, a network client or a tool
// declaration. Matched against code only, case-insensitively, as whole words.
const FORBIDDEN_WORDS =
  /\b(tools?|tool_?choice|function_?calls?|functions|apiKey|api_?key|authorization|bearer|credentials?|secrets?|passwords?|keychain|readFile|writeFile|createReadStream|createWriteStream|openSync|socket|http|https|net|fs|os|path)\b/i;

describe("07-02 truth 5: no credential, file handle, network client or tool declaration in the folder", () => {
  const files = readdirSync(FOLDER).filter(
    (name) => name.endsWith(".ts") && !name.includes(".test."),
  );

  it("scans the real module files", () => {
    expect(files.sort()).toEqual(["index.ts", "instructions.ts"]);
  });

  it("names none of those words in any non-test file's code", () => {
    for (const name of files) {
      const code = codeOnly(readFileSync(join(FOLDER, name), "utf8"));
      expect(code, name).not.toMatch(FORBIDDEN_WORDS);
    }
  });

  it("imports nothing from outside the folder except @ccc/domain", () => {
    for (const name of files) {
      const text = readFileSync(join(FOLDER, name), "utf8");
      const specifiers = [...text.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");
      for (const specifier of specifiers) {
        expect(
          specifier.startsWith("./") || specifier === "@ccc/domain",
          `${name}: ${specifier}`,
        ).toBe(true);
      }
    }
  });

  it("the scanner is not vacuous: it flags a tool field, a key and a file read in a probe", () => {
    for (const probe of [
      "interface R { tools: string[] }",
      "const apiKey = x;",
      "const s = readFile(p);",
      "const h = http;",
    ]) {
      expect(codeOnly(probe)).toMatch(FORBIDDEN_WORDS);
    }
    expect(codeOnly('// tools apiKey\nconst a = "http fs";')).not.toMatch(FORBIDDEN_WORDS);
  });
});
