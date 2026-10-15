import type { SourceFailureCode } from "@ccc/domain";

/**
 * Which addresses the research fetcher may request (D-09). Completed in Task 2 of plan 07-09;
 * this is the minimum the tracer needs (https only).
 */

export type FetchUrlContext = "source" | "redirect";

export type FetchUrlVerdict =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly code: SourceFailureCode };

export function validateFetchUrl(
  raw: string,
  context: FetchUrlContext = "source",
): FetchUrlVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: context === "redirect" ? "unsafe-redirect" : "parse-failure" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, code: context === "redirect" ? "unsafe-redirect" : "refused-address" };
  }
  url.hash = "";
  return { ok: true, url };
}
