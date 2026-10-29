---
status: accepted
satisfies: APPR-11, APPR-12
---

# Connector-class approvals need the owner's presence: a helper asks for Touch ID or the password and signs with a key only it can read, the service verifies that signature against a pinned public key, and what a same-user process can still do is stated in plain words

`APPR-11` asks that approving a connector-class request needs the owner's own gesture, and `APPR-12` that an approved row
carries a proof the service checks before it runs anything. ADR 0026 accepted the same-user self-approval risk for
milestone 1 and named a hardening decision as the gate before the Gmail and Calendar connectors. This record is that
decision as it shipped in Phase 9: what the mechanism is, what it rests on (measured, not assumed), the one exception it
makes to the stack's rules, and, in a section of its own, what a process running as the owner can still do. Decision
numbers (D-NN, R-NN) are those of `09-CONTEXT.md`; the measurements are those of the Phase 9 presence spike record.

## Context

ADR 0026 records that a prompt-injected agent running as the owner can open the service socket, obtain a token and call the
decide route for its own request. The socket's `0600` permission keeps other users out; it does not separate two processes
of the same user (ADR 0016). While the only real operation was force-terminate of a Claude session, that was accepted. A
connector writes outside this machine and cannot be undone, so for those operations an approval has to mean that the owner
was at the keyboard.

Two facts shaped the design. A helper's exit code is not proof of anything: any same-user process can print the same bytes.
And a Keychain item created through `/usr/bin/security` can be read by any same-user process, so a secret kept there proves
nothing about who is asking. The proof therefore has to be anchored in something the operating system enforces, and the
record has to say plainly how far that goes.

## Decision

### 1. The gate: connector-class writes only, approve only (D-02, R-03)

The classification table (ADR 0026) gains a `presence` property on every row. `required` means approving the request needs
the owner's verified presence; `none` means it does not. The gate covers connector-class external writes only (today the
reserved rows `publish` and `automation.git-write`). Reads, managed-vault writes and in-app actions are `none`, and
`session.force-terminate` is unchanged: it keeps its Phase 6 behaviour, an in-app approval with no presence gesture, and the
risk ADR 0026 accepted for it stands. No enabled production row is `required` yet, because no connector exists; the gate is
built and tested against a test-only connector row, so milestone 2 inherits it.

Denying never needs presence (R-03). A deny can only make an operation not happen, so the engine never asks the presence
port for a denial and a client holding only the token can still deny.

### 2. The mechanism: a small Objective-C helper compiled locally with clang (D-01, R-01)

The service asks a helper, `ccc-presence`, for the owner's presence. The source is one Objective-C file in the repository
(`scripts/presence/ccc-presence.m`). `scripts/presence/build.sh` compiles it at install time with
`xcrun clang -framework LocalAuthentication`, signs it ad hoc with the hardened runtime and the code identifier
`com.claude-command-center.presence`, and moves it into `<runtime dir>/bin/`. There is no node-gyp, no Electron native
addon and no binary in Git. The service runs the helper by absolute path, with no shell, a minimal environment, a capped
output and a deadline, exactly as it runs `/usr/bin/security` (stack §7).

The prompt is `LAPolicyDeviceOwnerAuthentication`: Touch ID, with the login password as the fallback on a Mac without Touch
ID. Its text is built inside the helper from the validated fields of the approval (operation, proposal id, payload hash,
instant) and never from caller-supplied text. The helper's exit codes are a closed set (0 ok, 2 usage, 3 unavailable, 4
denied, 5 internal); a prompt left unanswered for 60 seconds is a denial. The service accepts a presence answer only as one
strict JSON line from the expected exit code; anything else is `presence-unavailable`, and with no helper wired every
presence-required approval fails closed.

The decision to compile native code is an exception to the stack's stance of no native compilation, which is why the stack
chose `/usr/bin/security` for Keychain access. The exception is scoped. It is one source file compiled from the repository
on the owner's machine, with the Command Line Tools that the project already requires for `better-sqlite3`, and it is the
only native code in the product. It exists because no shell tool asks for Touch ID. The compiler is `clang`, not `swiftc`,
because the Command Line Tools `swiftc` on the owner's Mac could not build anything importing Foundation (research,
recorded under Considered Options).

### 3. Custody: a key the operating system lets only the helper read (R-02)

The spike chose the custody by a closed rule table over measurements, never by preference. The result is **custody K-ATTR**,
**pin `helper-acl-attribute`**, **channel `service`**:

- The helper creates a software P-256 key at enrolment. Its private part is the secret of a login-keychain item (service
  `com.claude-command-center`, account `approval-presence-pin`) whose access list trusts only the helper binary. Its public
  key (base64 SubjectPublicKeyInfo) is the item's comment attribute, the pin, which the service reads attribute-only,
  silently, without ever reading the secret.
- The helper signs only after the LocalAuthentication prompt succeeds, over the exact canonical approval message (see 4).
  The service never holds the signing key.
- The item records the enrolling binary's code-directory hash. `check` and `prove` report a pin enrolled by another binary as
  stale, before any prompt, with Keychain interaction disabled, so a stale access list fails fast and never raises a sheet at
  the headless service.
- The prompt reaches the owner from a LaunchAgent, which is how the service runs (measured, the `channel` field), so no
  fallback channel was needed.

K-SE (a Secure Enclave key) was not available: an ad-hoc-signed binary cannot create a persistent Secure Enclave key, which
the owner's own Terminal confirmed (`errSecMissingEntitlement`, -34018). A foreign change to the helper-only item raised a
Keychain access sheet and was refused (measured). A foreign delete of the item was not measured; see the Residual risk.

### 4. The proof: a MAC on every approved row, and a signature on presence-required rows (D-03, APPR-12)

Every approved row carries a proof in the `decision_proof` column (migration 0013). The column is written once, in the
transaction that moves a pending row to approved, and a trigger refuses any later change.

- **The MAC.** HMAC-SHA256 over the canonical fields: proposal id, operation, payload hash, state, approval instant and
  decided-via channel. The key is HKDF-SHA256 over the install secret with a fixed `info` string and no salt, derived once at
  startup and held only by the approval services. A copied proof is invalid on any other row or at any other instant. The MAC
  is detection only: the install secret is readable through `/usr/bin/security` by any same-user process, so a same-user
  process can compute a valid MAC. For a presence-required row the MAC never counts alone.
- **The presence signature.** For a presence-required row the proof also holds a presence part, `{ scheme: p256, sig }`: an
  ECDSA P-256 / SHA-256 signature, in DER, over the canonical message `{ v: 1, proposalId, operation, payloadHash, decision:
  "approve", approvedAt }`. The service verifies it against the pinned public key before it records the approval, and again
  at recovery, at the claim and at the last gate before execution. The MAC deliberately does not cover the presence part:
  the signature already binds the same fields, and the row is valid only if both checks pass. A MAC-valid presence-required row
  with no verifying signature is refused.
- **Where it is checked.** Before `store.decide` for a presence-required approve; for approved and executing rows at
  recovery; at `claimAndStart`; and at the last gate in `runAttempt`, which verifies the row the claim returned, not an
  earlier snapshot. A row without a valid proof is never reconciled, retried, claimed or run: an approved row is finished
  `failed` and an executing row `unknown`, with the code `proof-invalid` and the warning `approval-proof-invalid`. A pin that
  cannot be read right now (`pin-unavailable`) leaves the row alone and is retried at the next recovery.
- **The header.** The self-declared `X-Ccc-Decided-Via` header no longer authorises anything. It is an unverified hint
  (`plugin` or `other`) for operations that need no presence; `decided_via = presence` is written only by the engine after it
  has verified a presence signature, and a client can never produce it.

Replay of a copied valid proof is bounded to five minutes: the proof is useful only on its own row, because it binds the
proposal id and the approval instant, and an approval lives at most the maximum approval age (`maxApprovalAgeMs`, five
minutes) after that instant.

### 5. Prompts are rationed and refusals are recorded

At most 3 prompts per minute are started across all requests, one check at a time per proposal, and a denied prompt puts
that proposal on a 30-second cooldown. The engine bounds the helper call itself and abandons in-flight checks at shutdown.
A refused approve leaves the request pending and writes a `presence-refused` audit row whose detail is one closed reason
(`presence-denied`, `presence-unavailable`, `presence-budget` or `presence-cooldown`); those rows are capped per proposal so
they cannot push the request's own history out of the owner's trail. The pin is read before the prompt, so a missing pin
refuses without prompting, and the request is re-checked after that read.

### 6. A changed pin is detected (the delete-and-recreate residual)

Because prevention against a foreign delete depends on a measurement that is still pending, the service adds detection. It
reads the pin once as it starts; that is the trust-on-first-use point, and the SHA-256 of the first pin it sees is kept in
the service's metadata table. A later read that differs, outside an install, returns no pin, so presence signatures cannot
verify and presence-required rows wait, and the closed warning `presence-pin-changed` is logged once for each distinct
changed pin. The install script is the only legitimate writer: after a successful enrolment it leaves a marker file in the
runtime directory and restarts the service, and the boot read adopts the new pin once, logging `presence-pin-adopted` at
warn level. A marker counts only if it is a plain file (no link, directory or pipe) modified within the last ten minutes;
any other marker is deleted and ignored with the closed warning `presence-pin-marker-ignored`.

### 7. Diagnostics tells the truth about availability (D-04)

Diagnostics reports the presence mechanism as available, or as `unavailable` with a reason, never as working when it is
absent and never as zero (ADR 0031; delivered by plan 09-19). The decision pane words a refusal in the same closed
vocabulary, leaves the request pending and gives the owner a next step.

## Findings that shaped this decision

- **Swift did not build.** The Command Line Tools `swiftc` on the owner's Mac could not compile anything that imports
  Foundation (a compiler and SDK mismatch), while `clang` built a LocalAuthentication probe in about 1.2 seconds. That settled
  the language (R-01).
- **An agent shell is not the owner's shell.** The Secure Enclave probe returned a different error from an agent's
  non-interactive shell (-25308) than from the owner's own Terminal (-34018). The rule table uses the owner's value.
- **The prompt works from the service's context.** A throwaway LaunchAgent showed the LocalAuthentication sheet, so the
  service can be the caller; no plugin-side fallback was needed.
- **Library injection ran inside the one trusted binary.** A reviewer reproduced `DYLD_INSERT_LIBRARIES` running a constructor
  inside the ad-hoc-signed helper. The helper is now built with the hardened runtime, and the build test pins that an
  inserted library does not run.
- **A shadow keychain won the pin read.** The first pin read used the default search list, so a decoy item in a keychain a
  same-user process puts first would have been read. The helper and the service now name the login keychain explicitly and
  require the printed keychain, account and service to match.
- **The helper was a silent deleter.** Its `unenrol` removed the pin with no authentication, which made delete-and-recreate
  trivial through the genuine binary. `unenrol`, and the delete inside a re-enrolment, now need a LocalAuthentication success
  first, and install keeps the old helper when it cannot remove its key.
- **A check made on a snapshot is not a check.** The proof was first verified on the pre-claim snapshot, so a same-user writer
  changing the channel or the approval instant during the claim's awaits got a bad row executed. The last gate now verifies
  the row the claim returned, immediately before the effect.
- **A clock that steps backwards is an input.** A backward step between the expiry check and a second clock read could have
  let the expiry shortcut approve a presence-required request with no presence call; the shortcut can now only expire.
- **A bare marker file adopted an attacker's pin.** The first pin-change guard honoured any marker, with no age limit and no
  boot-time read. The boot read is now the trust-on-first-use point and a marker is time-bound and must be a plain file.

## Residual risk

This section says what the design does not stop. The plain statement comes first; the details follow.

**Roadmap success criterion 2 is partially met.** The sentence below is the one the spike record applies, and it is the one
the phase verifier reports:

Roadmap success criterion 2 is partially met: an approval of a connector-class request needs a signature from a key that only the hardened presence helper can read, and the helper signs only after the owner's Touch ID or password; but a same-user process that can delete the pin item and recreate it with its own key is not stopped (whether the item's access list gates a foreign delete was not measured), so the check is an operating-system-gated key plus a visible prompt with one recorded residual, not a proof against every same-user process.

What a process running as the owner can still do:

- **Cause a prompt, not answer it.** A process that holds the token can submit a request and ask to approve it, and so can
  cause a prompt to appear but cannot answer it: the answer is the owner's Touch ID or password at the keyboard, and the
  helper signs only after it. If the owner approves a prompt that an attacker caused for a request the attacker made, that
  is a real approval of that request, which is why the prompt shows the operation and the owner reads it.
- **Spend the prompt budget.** The global budget of 3 per minute can be spent by an attacker across several pending requests,
  so that the owner's own approve is refused for a while. The audit row says `presence-budget`. This costs the owner time; it
  approves nothing.
- **Replace the helper.** The helper binary sits in the owner's own directory, so a same-user process can replace it. A
  replacement build is not trusted by the pin item's access list and cannot read the key without a Keychain access sheet, and
  a replacement that merely prints "proved" produces no signature that verifies against the pin, so the service refuses it.
  Install rebuilds and re-enrols.
- **Read the install secret and so compute the MAC.** Any same-user process can read the install secret through
  `/usr/bin/security` and so compute the MAC, which makes the MAC detection and not a boundary. The MAC deliberately does not
  cover the presence part, and a presence-required row needs the verifying signature as well, which that process cannot make.
  For a row that needs no presence (such as force-terminate), a process that writes the store file and computes the MAC can
  still plant an approved row; that is the risk ADR 0026 accepted for those operations.
- **Delete and recreate the pin item.** The spike measured a foreign modify of the helper-only item (a sheet, refused), not a
  foreign delete. If the access list does not gate delete, a same-user process can silently delete the item, add one under
  the same service and account with a key and public key of its own, and sign with that key whenever it likes; the service
  would accept those signatures under the new pin. Until the measurement below is taken, treat delete as ungated.
- **Replace the keychain file, or attach a debugger or inject code into Obsidian or the service.** A debugger or code
  injection into Obsidian or the service, or replacing the login keychain file itself, is out of scope for the whole phase
  (D-03).

**Mitigations in place, each with a test** (they reduce the delete-and-recreate path; they do not close it): the helper runs
with the hardened runtime, so a library cannot be injected into the one binary the item trusts; the pin is read from the
login keychain by explicit path and must match keychain, account and service exactly, so a decoy in another keychain is not
read; unenrol and the replacement of an existing item need a LocalAuthentication success; the item is bound to the enrolling
binary's code-directory hash, and a pin another binary enrolled reads as stale before any prompt; install keeps the old
helper when it cannot remove its key; and the service keeps trust on first use of the pin and refuses signatures under a
changed pin outside an install (decision 6).

What detection does not stop, in the spike record's words:

A same-user process that replaces the pin item and then writes (or touches) a marker file within ten minutes, before the next pin read (the service restart, or the next presence verification), has its pin adopted: the marker is not authenticated, because everything that could authenticate it is also writable by that user. The same holds for a process that also rewrites the record in the service store. The guard therefore turns a silent swap into a logged `presence-pin-adopted` / `presence-pin-changed` event (and into nothing at all if the swap happens without a marker), but it is detection, not prevention.

In short, a same-user marker write within the window plus a pin replacement suffices. This is why the verdict stays partially
met.

**The measurement that can change the wording (owner, phase end).** Create a throwaway spike item with the spike tooling and,
from a different process, delete it with `security delete-generic-password`, recording whether a Keychain access sheet appears
as `attr_delete_prompts`. If it does (`yes`), a foreign delete is gated, the delete-and-recreate residual closes, and the
owner may restore the verdict to met by an explicit decision recorded in the spike record, after which this section and ADR
0026 change with it. If it does not (`no`), the residual stands and this record stays as written. Until the owner records the
measurement, the verdict is partially met.

**What was not run live.** The helper's Keychain-writing paths (`enrol`, `unenrol`, the secret read and the signing in
`prove`) were compiled and reviewed by the agents but are exercised live only by owner-run scripts (`test-custody.sh`,
`try-prompt.mjs`); the Cancel path from the installed service is an owner check. Automated tests use harness copies with the
prompt and Keychain calls stubbed and never touch the product item.

## Considered Options

**Swift compiled with swiftc.** Rejected. It was the first choice (D-01), but the Command Line Tools compiler and SDK on the
owner's Mac could not build anything importing Foundation. Objective-C compiled with `clang` builds the same
LocalAuthentication call and keeps the mechanism (OS-mediated presence, compiled locally, no prebuilt binary) unchanged (R-01).

**Peer-process identification on the socket.** Rejected. It identifies a process, not a person: an agent started from the
owner's own terminal has the owner's user and passes any check on the peer's identity, and it would still need native code.
The gesture is the thing that separates the owner from a process running as the owner.

**A separate decide credential.** Rejected. This was the fallback if the helper failed (D-01). A credential in a Keychain item
that any same-user process can read through `/usr/bin/security` is a secret, not a gesture. Restricting its access list to a
helper needs the helper anyway, which then did work, so the helper signs and the credential adds nothing.

**A native addon (node-gyp) or a prebuilt binary in Git.** Rejected. An addon breaks silently across Node and macOS upgrades,
which is the reason `keytar` is excluded, and a committed binary cannot be audited or rebuilt from the source in the
repository.

**K-SE, a Secure Enclave signing key.** Not available. It would give the strongest custody, and it was tried first, but an
ad-hoc-signed binary cannot create a persistent Secure Enclave key (`errSecMissingEntitlement`, -34018, measured from the
owner's Terminal). It would need an Apple-signed identity, which this single-user, sideloaded tool does not have.

**K-ATTR, a software key in a helper-only Keychain item.** Chosen (see decision 3). It is the strongest custody that works with
an ad-hoc signature: the key is readable only by the helper, a foreign modify raises a sheet and is refused, and the public
key is readable without any prompt.

**K-SVC, a service-held MAC and the helper's LocalAuthentication result.** Not chosen as the anchor. The decision would rest on
a secret any same-user process that reads the install secret can compute, so it is detection plus a visible prompt, not an
operating-system-held key. It remains in the design as the MAC floor beneath the signature (decision 4).

**Gating denials as well as approvals.** Rejected (R-03). A denial can only stop an operation, and a gate on it would let a
missing prompt hold a refusal hostage.

## Consequences

- A connector-class approval needs the owner's Touch ID or password, a signature that verifies against the pinned key, and a
  proof checked again before anything runs. The product does not claim more than this record says: the check is an
  operating-system-gated key and a visible prompt with one recorded residual, not a proof against every same-user process.
- Install gains an Objective-C build step and one Touch ID or password prompt when it replaces a helper, and uninstall one
  prompt; both are owner-initiated, and a cancelled prompt keeps the old helper with a warning.
- Every approved row carries a proof, so a row written by hand is refused at recovery and at the claim. A restart executes only
  rows the service itself approved (or, for a row that needs no presence, rows made by a holder of the install secret).
- A cancelled or unavailable prompt leaves the request pending; the owner can retry, deny, or let it expire.
- The classification table's `presence` column is checked against the domain table by the ADR 0026 gate, and this record's
  content is pinned by the same gate suite, so neither can drift from the code or soften the residual risk silently.
- The Phase 6 acceptance for force-terminate, and the milestone 2 gate in ADR 0026, are answered by this record for
  connector-class writes; ADR 0026 and ADR 0016 point here.
