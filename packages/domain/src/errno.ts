/**
 * The string `code` of a thrown value (a Node `errno` such as `ENOENT`, or a
 * closed request-error code such as `timeout`), or `null`. Browser-safe: no
 * Node import. The message is never read, so a path or payload inside it cannot
 * leak into user-facing copy (T-09-11); a non-string `code` reads as `null`.
 */
export function errnoOf(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}
