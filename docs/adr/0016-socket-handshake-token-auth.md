---
status: accepted
satisfies: ADR-02 (auth half; ADR-0001 carries the transport half)
---

# Handshake mints a short-lived HMAC bearer token, layered on the socket's `0600` permission

ADR-0001 already makes the socket unreachable by any browser and by any other local user — that
closes the dominant threat this service faces. What `0600` does not close: any other process
running as the *same* OS user can still open the socket. It has no way to discover the socket's
path unless it can already read the filesystem, and the path is short and conventional
(`~/.claude-command-center/svc.sock`), so once such a process connects it is indistinguishable
from the legitimate plugin without a further check. `SVC-03` also requires every mutating and
private-read endpoint to present a valid bearer token, in its own literal text, independent of
what the socket permission already buys.

We generate a per-install secret once (`crypto.randomBytes(32)`), store it in the macOS
Keychain, and mint short-lived (one-hour) HMAC-SHA256 bearer tokens from it. `POST
/api/v1/handshake` is the one route that does not itself require a token: the socket's `0600`
permission is the authorization event for reaching it at all — there is nothing the caller could
present on a first connection, the same resolution SSH agent sockets and the Docker socket use.
Every other route, starting with `GET /api/v1/health`, is wrapped in `requireToken` and rejects a
missing, malformed, mis-signed, or expired token with a uniform `401 {"error":"authentication
required"}` body — the specific reason is logged locally, never returned, so the endpoint cannot
be used as an oracle for which part of a caller's token is wrong.

## Considered Options

**No token layer at all, relying solely on the socket's `0600` permission.** Rejected. This
technically satisfies the transport-level threat model ADR-0001 already closes, but it does not
satisfy `SVC-03`'s literal requirement text and leaves same-user-process isolation entirely
unaddressed — any other process running as the owner could open the socket and act as the
plugin indefinitely, with no distinguishing signal anywhere.

**A long-lived static token, generated once and never rotated.** Rejected. A token that never
expires is a second permanent credential with none of the socket's own protections — if it ever
reached a log line or a crash report, it would remain valid for the life of the installation.
Short expiry contains exactly that leak.

**Short-lived HMAC-signed bearer token, minted on handshake (chosen).** One hour TTL, HMAC-SHA256
over `{issuedAt, expiresAt, nonce}` keyed by the per-install secret, verified with
`timingSafeEqual`. Cheap to implement, satisfies `SVC-03`'s literal wording, and is genuine
defense-in-depth layered on top of (never instead of) the socket permission.

## Consequences

- **The socket's `0600` permission remains the control that matters most** — it is what makes the
  service unreachable from a browser and from any other local user, structurally, per ADR-0001.
  This ADR does not restate or reassign that claim to the token layer.
- **What the token layer actually adds**, narrower than in the TCP design an earlier research pass
  once proposed for this project: (a) request replay / log-leak containment — a token that leaks
  into a log line expires within an hour rather than being a permanent credential; (b) a place to
  hang per-connection revocation, via `invalidateToken()` on the plugin's `onunload()`; (c) makes
  every mutating/private-read request explicitly authenticated in code, satisfying `SVC-03`'s
  literal text even though the socket permission is doing most of the real work.
- The token layer does **not** defend against DNS rebinding or browser CSRF — those are already
  structurally impossible per ADR-0001 — and it does not defend against a same-user attacker who
  can already read the Keychain item too; same-user Keychain access without a fresh
  biometric/password prompt is an OS-level question this service does not control.
- Signing uses `node:crypto` exclusively (`createHmac`, `randomBytes`, `timingSafeEqual`) — no
  third-party JWT/signing library, keeping the token format and verification logic small enough
  to read in one sitting.
