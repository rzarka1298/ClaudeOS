---
status: accepted
satisfies: ADR-05
---

# The per-install secret lives only in the macOS Keychain; logs redact by construction

ADR-0009 already decided the mechanism — shell out to `/usr/bin/security` rather than bind a
native Keychain addon. This ADR is the load-bearing detail ADR-0009 left to this plan: exactly
what the service and account names are, how a not-found item is told apart from a genuine
failure, what an operator sees the first time the Keychain gates access, and how the rest of the
service (logs, the operational store, the plugin's own persisted settings) is kept from ever
holding a copy of the secret it retrieves.

`packages/keychain/src/security-cli.ts` is the *only* module in the repository that spawns
`security`. `getSecret`/`setSecret`/`deleteSecret` wrap `find-generic-password` /
`add-generic-password -U` / `delete-generic-password` under the Keychain service name
`com.claude-command-center`. Every invocation passes an argument array — never a string built by
concatenating a caller-supplied account or value — because that is exactly the injection vector a
project name or account label reaching a shell would open. Exit code 44 means the item does not
exist; `security-cli.test.ts` asserts that specific code maps to `null` rather than being treated
as a generic failure, and every other non-zero exit code rethrows.

`setSecret` never puts the plaintext value in argv: a plain `add-generic-password -w <value>`
would leave the secret visible in `ps`/`KERN_PROCARGS2` for the child process's entire lifetime to
any other process running as the same user. Instead it spawns `security -i` (interactive mode)
with only `-i` in argv, and writes the full `add-generic-password -a ... -s ... -w ... -U` command
line over stdin. Account, service name, and value are rejected outright (a typed
`UnsafeSecretInputError`, not creative escaping) if any contains a double quote or a newline,
since either would corrupt the single-line stdin command.

`packages/service/src/auth/install-secret.ts` reads the `install-secret` account through an
injected `SecretStore`, generating one via `randomBytes(32)` and writing it back on first use, and
caches the result in module scope so the Keychain is consulted at most once per process start.
`packages/service/src/logging.ts` wraps `pino` with a `redact` configuration covering `token`,
`secret`, `installSecret`, `authorization` (including the nested `req.headers.authorization`
shape), and `password` — at the top level and one level of nesting — censoring every match to
`[redacted]`, plus a serializer that truncates any `body`/`content` field past 512 characters so a
complete message body never reaches a log line (SVC-10).

## Considered Options

**`keytar` (the classic native Keychain binding).** Rejected. Archived upstream, unmaintained,
and a `node-gyp` native build step that would break the clean-clone promise REPO-01 makes on a
machine without Xcode Command Line Tools already installed for an unrelated reason.

**`@github/keytar` (the maintained fork).** Rejected for the same reason: it is still a native
addon requiring `node-gyp`, just with an active maintainer. The build-step cost this ADR is
avoiding is inherent to any native binding, not specific to the original package's abandonment.

**Shell out to `/usr/bin/security` (chosen, per ADR-0009).** Zero native compilation, the same
pattern `git`, `docker`, and `gh` already use for their own credential helpers, and the tool ships
on every macOS install — nothing to bundle, nothing to compile.

## Consequences

- The first time the service's `security` invocation reads or writes the `install-secret` item
  under a code-signing identity macOS has not seen before, macOS may present a one-time "Always
  Allow" access dialog. This is expected behaviour, not a defect — identical to what `gh` and
  `git-credential-osxkeychain` users already see once. It should be surfaced explicitly in the
  onboarding and diagnostics views (PRD §12.3) so a first-run user does not mistake it for a bug.
- **Amendment (Phase 8, plan 08-04, D-38): presence is checked attribute-only.** Diagnostics
  and the Security section must say whether the install secret and the research key are stored
  without ever reading them, so `@ccc/keychain` gains `hasSecret(account)`. It runs
  `/usr/bin/security find-generic-password -a <account> -s <service>` by absolute path with an
  argv array (no shell) and **no `-w` and no `-g`**, so the value is never read into the process
  or printed; stdin, stdout and stderr are ignored. Exit 0 is `present`, exit 44 is `absent`,
  and anything else (another exit, a timeout, a kill, a spawn failure) is `error`, never a guess.
  The account passes the same safe-identifier check as the other calls and may not start with a
  dash; the lookup is killed with SIGKILL after 1.5 seconds. It runs only on an owner gesture:
  opening Diagnostics, Security or Paths, pressing Run checks again in Diagnostics, or pressing it
  in the diagnostic-bundle block. It never runs on a reconnect (a launchd restart, a wake from
  sleep) or on a timer, so a one-time access dialog could only appear while the owner is looking
  at the screen. A reconnect answers from memory with the last gesture's answer only while that
  answer is under five minutes old (`HEALTH_STALE_AFTER_MS`), and `not checked` otherwise. Unit
  tests use a mocked `execa` and never spawn the real `security`. The first real-keychain run is
  confirmed prompt-free by one owner UAT item (08-UAT item 36).
  *Correction (Phase 8 FIX6A, 2026-10-23):* this text used to say that the sandbox runner uses a
  stub for the automated items, and that the check runs on opening Diagnostics or pressing its
  re-check control only. Neither was accurate. The automated runs do real attribute-only lookups
  (no `-w`, no `-g`) of a nonexistent `ccc-uat-*-nokey` account against the owner's login
  keychain; the lookup finds nothing and reads nothing. Automated item 36 also creates one
  ledgered `ccc-uat-*-research` item with a placeholder value, looks it up, and deletes it; the
  ledger removes it on teardown if the run stops early. The login keychain must therefore be
  unlocked, which is normal while the owner is logged in, during an automated run. None of the
  owner's own Keychain items is looked up, read or changed by an automated run.
  `SecretStore` is unchanged: the service wraps `hasSecret` in a closure (08-12).
- Secrets never reach the operational SQLite store, the managed vault, a dotfile, or a log line —
  the only path to disk is through `security-cli.ts`'s own Keychain calls. A marker-injection
  integration assertion in `authenticated-roundtrip.test.ts` proves this for real: it reads the
  actual generated secret back out of the Keychain, then greps both the operational database's raw
  bytes and the service's log file for that exact value and asserts neither contains it.
- The plugin's persisted settings (`packages/plugin/src/settings.ts`) declare no credential-shaped
  field, and `assertNoCredentialFields` throws before every `saveData` call — PLUG-07 fails loudly
  at save time rather than silently regressing if a future change adds a `token`/`secret`-shaped
  field to what the plugin persists.
- When OAuth refresh tokens arrive with Connectors in a later milestone, they are stored through
  this same `@ccc/keychain` wrapper and nowhere else — this ADR's account-naming and
  argument-array discipline is the pattern that extends, not a one-off for the install secret.
- No credential-acquiring flow (OAuth redirect, token exchange, provider client) is implemented in
  this phase — only the install secret and the mechanism that will later hold OAuth tokens.
