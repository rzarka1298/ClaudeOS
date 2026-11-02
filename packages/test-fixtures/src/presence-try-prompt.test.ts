// The owner's presence UAT script (scripts/presence/try-prompt.mjs, plan 09-15): its judging logic, tested
// with locally generated keys. The script's main() (which would raise a real prompt) is never run here:
// only the pure `judge` export is.
import { generateKeyPairSync, sign } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = join(
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
  "scripts",
  "presence",
  "try-prompt.mjs",
);

type Result =
  | { kind: "proved"; scheme: "p256" | "none"; signature: string | null }
  | { kind: "denied" }
  | { kind: "unavailable" };
type Verdict = "verified" | "refused" | "unavailable";
const { judge, PIN_ACCOUNT } = (await import(pathToFileURL(SCRIPT).href)) as {
  judge(input: { result: Result; message: string; pin: string | null }): Verdict;
  PIN_ACCOUNT: string;
};

const MESSAGE = '{"approvedAt":"2026-10-28T12:00:00.000Z","decision":"approve","v":1}';

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pin = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const signature = (message: string): string =>
    sign("sha256", Buffer.from(message, "utf8"), { key: privateKey, dsaEncoding: "der" }).toString(
      "base64",
    );
  return { pin, signature };
}

describe("09-15 try-prompt judge", () => {
  it("reads the pin from the helper's own Keychain account", () => {
    expect(PIN_ACCOUNT).toBe("approval-presence-pin");
  });

  it("a p256 signature over the message under the pinned key is verified", () => {
    const { pin, signature } = keyPair();
    const result: Result = { kind: "proved", scheme: "p256", signature: signature(MESSAGE) };
    expect(judge({ result, message: MESSAGE, pin })).toBe("verified");
  });

  it("a signature over another message, under another key, or garbage is refused", () => {
    const { pin, signature } = keyPair();
    const other = keyPair();
    const proved = (sig: string): Result => ({ kind: "proved", scheme: "p256", signature: sig });
    expect(judge({ result: proved(signature(`${MESSAGE} `)), message: MESSAGE, pin })).toBe(
      "refused",
    );
    expect(judge({ result: proved(other.signature(MESSAGE)), message: MESSAGE, pin })).toBe(
      "refused",
    );
    expect(judge({ result: proved("AAAA"), message: MESSAGE, pin })).toBe("refused");
    expect(
      judge({ result: proved(signature(MESSAGE)), message: MESSAGE, pin: "bm90IGEga2V5" }),
    ).toBe("refused");
  });

  it("a cancel is refused; an unavailable helper, a missing pin and the no-key scheme are unavailable", () => {
    const { pin, signature } = keyPair();
    expect(judge({ result: { kind: "denied" }, message: MESSAGE, pin })).toBe("refused");
    expect(judge({ result: { kind: "unavailable" }, message: MESSAGE, pin })).toBe("unavailable");
    expect(
      judge({
        result: { kind: "proved", scheme: "p256", signature: signature(MESSAGE) },
        message: MESSAGE,
        pin: null,
      }),
    ).toBe("unavailable");
    expect(
      judge({
        result: { kind: "proved", scheme: "none", signature: null },
        message: MESSAGE,
        pin,
      }),
    ).toBe("unavailable");
  });
});
