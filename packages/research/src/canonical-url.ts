// URL canonicalisation (D-11, research Pattern 4). Signature stub: the behaviour arrives with the
// tests that pin it.

export const URL_REJECT_REASONS = [
  "invalid-url",
  "not-https",
  "userinfo",
  "bad-port",
  "empty-host",
  "too-long",
] as const;

export type UrlRejectReason = (typeof URL_REJECT_REASONS)[number];

export type CanonicalUrlResult =
  | { readonly ok: true; readonly url: string; readonly host: string }
  | { readonly ok: false; readonly reason: UrlRejectReason };

export function canonicaliseUrl(_input: string): CanonicalUrlResult {
  return { ok: false, reason: "invalid-url" };
}
