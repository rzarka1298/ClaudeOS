---
status: accepted
satisfies: DIAG-02, DIAG-03, DIAG-04
---

# Health is five statuses derived from closed reason codes, read by capped read-only probes, and a bug-report bundle is built from an allowlist and checked before it is offered

`DIAG-02` asks for the honest state of six subsystems, `DIAG-03` for a specific setup state when something is missing, and
`DIAG-04` for a sanitised diagnostic bundle that is verified free of home paths, personal addresses and private project
names. This record fixes the model the three share: what a status is and how it is derived, how the probes behave, what
the service is allowed to say about a vault it will not name, and exactly what the bundle can hold and how it is
checked. Decision numbers (D-NN) are those of `08-CONTEXT.md`.

## Context

The system already holds a status for each subsystem in its own words: the Claude integration status, the Codex
integration status, the research status, the saved launcher rows, the persisted vault root. Diagnostics must not invent a
second answer for any of them (D-04), must not turn a missing integration into an error (D-07, D-34), must not claim a
guess is working (ADR 0002, "never invent a state"), and must not let anything personal reach a public bug report. The
service is local and the owner is its only user, but the bundle is meant to leave the machine, so the second half is a
privacy boundary, not a convenience.

## Decision

### 1. A status is one of five, beside the four freshness values, and is derived from a reason code (D-06, D-34, D-35)

`SubsystemStatus` is `ok`, `setup-needed`, `degraded`, `failing` or `unknown`. It is a separate vocabulary from the
four-value freshness of ADR 0002 (`live`, `cached`, `stale`, `unavailable`), which ADR 0002 forbids extending:
freshness says how old an answer is, status says what the answer is. Every row carries a status, a **closed reason
code** from a per-subsystem list, a check time, a freshness and an optional setup action. The status is never sent free:
it is a pure function of the reason code (one table per subsystem, typed so that a missing mapping is a compile error),
and the strict schemas refuse a row whose status disagrees with its reason's.

A row made of parts (collectors, scheduler, launchers) takes the **roll-up** of its parts: `failing` beats `degraded`
beats `unknown` beats `ok`, and `setup-needed` only when every part is. Some parts are **passive** (the collectors'
telemetry and spool, the scheduler's sources): they cannot be "not set up", so an `ok` passive part never lifts a row
whose other parts are all `setup-needed`. A fresh install therefore reads the companion service `ok` and the five
service-side rows `setup-needed`, with no `failing` or `degraded` row (D-34). The row's reason is the deciding part's,
and its setup action and facts are that part's.

`unknown` is used for idleness and for not having looked: hooks that are installed but silent are `unknown`
(`no-events-yet`, `events-silent`), never `degraded`, because the last-event time is process memory and idle is not a
fault (D-35). A Claude `settings.json` that does not exist is a fact, not an unknown: nothing of ours is installed, so the
hooks and status-line parts read `setup-needed` with the copy-command action; only a file that exists and cannot be read
(permissions, a FIFO or device, a directory, over 1 MiB, invalid JSON) reads `unknown`. A probe that did not finish is `unknown` (`probe-timeout`, `probe-error`, `subsystem-not-wired`); a
service the plugin cannot reach clears every service-dependent row to `unknown` (`service-not-running`), never to a last
good value (D-03).

The dropped-hook-records part is **stateless** (D-37a): `degraded` while the dropped-records file is non-empty and was last
written within 24 hours, otherwise `ok` with the count kept as a fact. The service remembers nothing about earlier probes,
so drops made while it was down read `degraded` on the first probe, a reconnect consumes nothing, and a day-old drop stops
being news without anyone clearing the file. The facts are `dropCount` and `lastDropAt` (a UTC instant).

The companion-service row is computed in the plugin from its connection state. Two reasons, the vault mismatch
(`vault-mismatch`, `vault-check-unavailable`) and `service-not-running`, are produced only by the plugin; the strict
service response refuses them, and a row carrying one has a different type from a row the service sent.

### 2. Probes are read-only, bounded and run on a short leash (D-05, DIAG-02)

One authenticated fixed-path route, `GET /api/v1/diagnostics/health`, runs five probes (vault, hooks, collectors,
scheduler, launchers). The Phase 1 health route and its schema are untouched (D-02). Each probe takes narrow injected
ports and an abort signal and returns a row without its check time. The runner gives each probe its own 2 second cap and
all of them a 5 second cap, joined with `AbortSignal.any`, so aborting also kills any child a probe started. **No probe
and no port it is handed makes a synchronous file-system call**: every read is asynchronous and raced against the signal, so
a path on a stalled network mount holds a thread-pool thread while the timers fire and the row reads `probe-timeout`; a
synchronous call would hold the event loop past both caps. A probe that
is cut reads `unknown` / `probe-timeout`; one that throws, or returns a row the strict schema refuses, reads `unknown` /
`probe-error`; both carry freshness `unavailable`; a result that arrives after its cap is discarded; every timer is
cleared. A request shares the run already in flight for its trigger and a result younger than 2 seconds (measured on a monotonic
clock, so a stepped wall clock cannot freeze a stale result) is served as `cached` with its original check time, so a hostile or buggy local client cannot start a storm of lookups.

A probe launches nothing, installs nothing, writes nothing and uses no network (D-05). It projects the status the
service already holds (`refreshSettingsFacts`, the cached Codex status, the research status, the saved launcher rows) and
never runs `codex doctor`, `claude --version` or a Codex refresh. The only processes a probe's ports reach are the fixed-
argv, absolute-binary, `shell: false` lookups added for this purpose: one `mdfind` and up to two `plutil` reads for a
saved app (D-49) and an attribute-only `security find-generic-password` for the research key (D-38, ADR 0017). Backstop
rule 18 and a source scan keep the diagnostics folder free of any network module, direct `child_process` or `execa`
import, file-system write or synchronous file-system call, and of the routes around an import statement
(`getBuiltinModule`, `process.binding`, `createRequire`, `require(`, a computed `globalThis`/`process` access, `Reflect`,
`eval`, `Function(`, a computed `import(`). Imports are normalised against the folder: one may leave it only for the
logger, the route kit's `withAuth`/`sendJson`/`Handler` and the vault root policy's `isForbiddenRoot`, by name, and none may
name a test file. The scan strips comments with a string-aware reader, so a comment opener inside a string hides nothing.

The Keychain presence check runs **only on an owner gesture**. The route takes `trigger=gesture|reconnect`; only an exact
single `gesture` is a gesture, and the cache is keyed by trigger. A reconnect answers from the last gesture's result in
memory while that result is under five minutes old (`HEALTH_STALE_AFTER_MS`, the same window the plugin uses to show a row
as `Stale`), and `research-key-not-checked` otherwise, so an old answer never reads as a fresh one (FIX6A). The diagnostic
bundle ages each row the same way: a row whose `checkedAt` is more than that window before the bundle's `generatedAt` is
exported `stale`, not `live`.

### 3. The service never names the vault; it sends a salted fingerprint (D-36)

The persisted vault root is service-private. The response carries `{ salt, digest }`: a random salt drawn once per service
process and the first 16 hex characters of SHA-256 over `salt`, a colon and the root. The plugin hashes its own vault path
with the same salt and compares. The root, a display path of it and the fingerprint never enter the bundle. The vault
probe itself reads only the persisted root (and a failure to read it is that row's `probe-error`, never a failed
response): it checks it with asynchronous calls (a stalled mount cannot block the event loop), refuses a forbidden
location, checks read and write access without writing, checks the Obsidian marker and only then `stat`s each managed
folder, also asynchronously and one after another, stopping at the first missing one. Every error maps to a closed code;
an error message is never read.

Display paths in the response (the runtime folder, the socket, the vault) are `~/...` or `.../parent/name` strings built
by one browser-safe helper; the owner's user segment never appears, and none is persisted. A path whose display form
would exceed the schema's 512 characters falls back to its last segment (`~/…/name`, truncated to fit), so one hostile
folder name cannot make the whole response fail.

### 4. The bundle is built from an allowlist, never scrubbed (D-10, OD-5)

The bundle schema is strict at every level and admits versions, the platform, the connection **state** (never its reason),
the six subsystem rows as status plus reason code plus times plus parts of id, status and reason, nullable integer counts
(null, never zero, when unknown: projects, scan folders, open tasks by the tasks list's actionable rule, and recorded reports,
the store's research report records and not a vault walk), feature flags, and the plugin's diagnostic records reduced to source, code and time, where
the code is one of a closed list of six that the plugin writes (any other code is skipped by the builder and refused by
the schema). A version is two to four numeric components with at most one `-alpha`, `-beta` or `-rc` suffix (and a counter);
anything else, including `0.1.0-SomeName`, is null. It
contains no log line, path, display path, title, name, free-text message, fingerprint or keychain value. The builder takes a
narrow typed input and constructs the output by **explicit field picks**, then parses it; a type-level test fails when the
input gains a key that is not mapped. A canary placed in every free-text source field of the input never appears in the
output.

### 5. A verifier is the second, independent check (D-11, D-14)

Before a bundle is offered, the verifier runs (`verifyAndSerialise`, which wraps `verifyBundle`), in this order: the shape rules and the owner's denylist on every key and
string value, in every spelling (as written, JSON-unescaped, percent-decoded once and twice, and normalised with
compatibility characters folded and zero-width characters removed); the same shape rules on the serialisation; the strict
schema; the size (32 KiB). Privacy rules run first, so a bundle that is both malformed and leaky is refused for the leak.

The shape rules are the two of `scripts/check-privacy.sh` (a home path whose user segment is not a documented placeholder,
and an email address not on an example domain), ported once, with a gate that keeps their source text, the placeholder
list and the exemption equal to the script's, plus the shapes the script lacks: `/home/`, `~/`, `$HOME`, `file://`,
temporary-folder and run-root paths, this project's bearer token, provider key prefixes, JWTs, UUIDs, long hex, and a long
base64-like run. The denylist is built at run time from data the plugin already holds: project display names and folder
basenames, GitHub owner, repository and owner/repository, the vault name and the macOS short user name. It matches after
folding (compatibility decomposition, combining marks and format characters removed, lower case) and also with separators
removed. `.privacy-denylist.local` is not used: it does not exist on another install.

False refusals would make export permanently impossible, so the verifier is built not to refuse the builder's own output:
entries shorter than four characters or equal to a token of the bundle's own closed vocabulary are dropped, and the
denylist skips strings the schema types as a closed token or a UTC instant, and the schema's own keys; a version is
checked with its numeric components ignored (so a name such as `2026` or `1.13` cannot match inside it, while a name riding
on a version suffix is refused).
A property test over 500 generated clean inputs proves the verifier accepts everything the builder produces.

The refusal is one of eleven closed codes: `home-path`, `tilde-path`, `email`, `token-shaped`, `denylist-project`,
`denylist-folder`, `denylist-github`, `denylist-vault`, `denylist-user`, `schema-invalid`, `too-large`. It names the rule,
never the value, in the result, the UI and any log.

### 6. Delivery: copy or save, once, outside the vault (D-12, D-13)

The Diagnostics section shows a preview of the exact string and offers Copy and Save. `verifyAndSerialise` serialises the
bundle exactly once, parses that same text back, verifies the parsed copy and scans the text, and returns `{ ok, text }` or
the refusing rule; the preview, Copy and Save all use that returned text and nothing else, so a getter or `toJSON` that
changes after the check cannot change what is offered. Save goes through Electron's save dialog (with a typed
fallback to Copy only) and refuses a location inside the open vault; the bundle is never written into the vault, never
persisted in the plugin's settings, and the service has no bundle-writing route. Export is a new `direct-gesture` row
(`diagnostics.export-bundle`) in the static classification table and in the table of ADR 0026; the probes get no row,
because they are read-only local queries (D-40).

### 7. What the owner chose by default

The record rests on three owner defaults (`08-CONTEXT.md`): **OD-2**, Gmail, Calendar and GitHub appear as honest "Not part
of this version" rows with no Connect button and are not in the bundle; **OD-4**, Keychain presence is shown read-only and
an owner-run script is offered, with no in-app credential change in milestone 1; **OD-5**, the bundle holds schema-only
facts, no log lines and no free text, delivered by Copy and a Save dialog.

## Consequences

- A new subsystem state is a new reason code with a status in a table and a line of copy; the build fails until both exist.
- The bundle cannot grow a free-text field without a schema change, a type-test change and a corpus entry.
- The verifier is stricter than the builder needs to be on purpose. A real owner name that is also a vocabulary token (or one
  of the pre-release words) is, by construction, not user text and is not refused; a name that merely appears among the
  numbers of a version is not refused either.
- Homoglyph substitution (a Cyrillic letter for a Latin one) is not folded; the builder never places a name in the bundle,
  so this is a limit of the second check only.
- Backstop rule 18 means a probe that needs a process or a socket must ask for a port the composition root builds, which is
  where review looks for it.
