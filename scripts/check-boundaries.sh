#!/bin/sh
# Literal grep backstop layered under the eslint-plugin-boundaries lint rule
# (eslint.config.mjs) and the TypeScript project-reference layer
# (tsconfig.base.json) -- the third of the three boundary-gate layers
# recorded in docs/adr/0019-import-boundary-enforcement.md. A lint rule
# catches import edges through its element-type glob map; this script
# catches the case where that glob map silently stops matching (a config
# typo, a moved directory) by re-deriving the same prohibitions from a
# completely independent mechanism: a plain literal grep over tracked
# source files.
#
# Exits non-zero with the offending file and line on any hit. Comment lines
# are filtered out of every match so a header comment describing a rule (for
# example this file's own prose, or an eslint.config.mjs comment naming
# "obsidian" or "node:http") can never itself trip the gate it documents.
#
# Rule inventory:
#   1. no file outside packages/plugin imports the Obsidian API
#   2. no file inside packages/plugin reaches the network by any route other
#      than @ccc/service-api-client -- http/https/net module imports, the
#      fetch/XMLHttpRequest/WebSocket/EventSource globals (which need no
#      import at all), and Obsidian's own requestUrl helper (ADR-0001)
#   3. only packages/service and packages/operational-store import
#      better-sqlite3
#   4. only packages/keychain spawns the macOS security(1) tool
#   5. no file anywhere references a mail-transport module or SMTP client
#   6. no file inside packages/plugin uses a DOM HTML-injection sink
#      (innerHTML/outerHTML/insertAdjacentHTML/dangerouslySetInnerHTML)
#   7. no file inside packages/plugin assigns an inline style -- state
#      reaches CSS through data-* attributes and --ccc-* tokens (UI-03)
#   8. no file in packages/launchers or packages/service starts a process
#      through a shell (exec/execSync, a `shell:` option whose value is not
#      false, a dynamic import of child_process) -- D-18
#   9. no file inside packages/service, packages/collectors or
#      packages/plugin sends the interrupt signal to a process (PR-01) --
#      by name in a kill call, held in a variable or constant, or as a
#      kill(1) flag via execFile; receiving it in a handler stays allowed
#  10. no non-test file forges a CapabilityToken -- a cast, a typed
#      initializer, JSON.parse or `any` fed to a capability-typed call --
#      only the approval engine issues one (ADR-0012, PR-26); the one
#      anchored carve-out is the engine's minter file,
#      packages/service/src/approval/mint/mint-token.ts (D-02), and it is
#      still subject to the `any` scan
#  11. no file outside packages/service/src/approval/ imports the approval
#      minter -- an import, export-from, side-effect or dynamic import whose
#      specifier contains approval/mint (T-06-01, T-06-15)
#  12. no file outside packages/service/src/executors/ and the composition
#      root packages/service/src/main.ts imports an executor -- a specifier
#      reaching the executors folder (T-06-02, T-06-15)
#  13. no file outside packages/service/src/claude/ calls process.kill( --
#      the Claude services own the only process-signal sites (T-06-02)
#  14. no file outside packages/service/src/executors/ calls .terminate( with
#      a leading dot; a method definition named terminate is not a call
#      (T-06-02)
#  15. the approval public door approval/index.ts never references the minter
#      (MAJOR-2)
#  Rules 11 to 14 scan non-test source files only and skip comment lines;
#  every allow-list below is an anchored `^...` path match, never a substring.
#
# Rules 6 and 7 mirror DOM_SAFETY_RULES, and rule 2 mirrors
# NETWORK_ISOLATION_RULES, in packages/plugin/eslint.config.mjs; rule 8
# mirrors the process-spawn no-restricted-syntax block in the root
# eslint.config.mjs. The duplication is the point: this script is the layer
# that still reports when the lint's config silently stops matching.
#
# Note on patterns: every pattern below is passed to awk via `-v`, which
# processes backslash escapes BEFORE awk sees the regex -- `\b` becomes a
# literal backspace and `\(` becomes an unescaped group opener ("illegal
# primary in regular expression"). Word boundaries are therefore written as
# `(^|[^A-Za-z0-9_])` and literal punctuation as a bracket expression
# (`[(]`, `[.]`), never with a backslash.

set -eu

FAILURES=0
RULES=0

# Every tracked TypeScript source file under packages/, excluding build
# output and both fixture trees. `boundary-violations/` (plan 01-03 task 1)
# and `lint-fixtures/` (plan 03-01 tasks 2-3) exist specifically to violate
# these rules under their respective lint gates, and each is asserted to fire
# by a committed test -- so they must not also trip the backstop, which would
# make this gate permanently red for files that are doing their job.
# Both exclusions are anchored to the fixture trees' REAL paths (judge-r1
# finding 9): an unanchored substring match skipped every other path that
# merely contained `lint-fixtures/` or `boundary-violations/`, so a file could
# escape the backstop by the name of its directory.
list_source_files() {
  git ls-files -z -- 'packages/*.ts' 'packages/*.tsx' 2>/dev/null | \
    tr '\0' '\n' | \
    grep -v '/dist/' | \
    grep -v '/node_modules/' | \
    grep -v '^packages/test-fixtures/boundary-violations/' | \
    grep -v '^packages/plugin/lint-fixtures/'
}

# Prints "file:line:content" for every non-comment line in the given files
# matching the given extended regex. A "comment line" is one whose
# leading (whitespace-trimmed) characters are `//`, `/*`, or `*` (single-line
# comment, block-comment opener, or a JSDoc continuation line).
grep_noncomment() {
  pattern="$1"
  shift
  for f in "$@"; do
    [ -f "$f" ] || continue
    awk -v pattern="$pattern" -v fname="$f" '
      {
        trimmed = $0
        sub(/^[ \t]+/, "", trimmed)
        is_comment = (trimmed ~ /^\/\//) || (trimmed ~ /^\/\*/) || (trimmed ~ /^\*/)
        if (!is_comment && $0 ~ pattern) {
          print fname ":" NR ":" $0
        }
      }
    ' "$f"
  done
}

check_rule() {
  description="$1"
  pattern="$2"
  shift 2
  # Remaining args: files to scan (already pre-filtered by caller to the
  # relevant subset -- e.g. "every source file outside packages/plugin").
  hits=$(grep_noncomment "$pattern" "$@" || true)
  report_rule "$description" "$hits"
}

# Counts one rule and reports its hits (already collected by the caller,
# possibly from several scans), failing the run when there are any.
report_rule() {
  RULES=$((RULES + 1))
  if [ -n "$2" ]; then
    echo "BOUNDARY VIOLATION: $1"
    echo "$2"
    FAILURES=$((FAILURES + 1))
  fi
}

SRC_FILES=$(list_source_files)

# --- Rule 1: no file outside packages/plugin imports the Obsidian API ---
NON_PLUGIN_FILES=$(printf '%s\n' "$SRC_FILES" | grep -v '^packages/plugin/' || true)
# shellcheck disable=SC2086
check_rule \
  "a file outside packages/plugin imports the Obsidian API" \
  "from[[:space:]]*[\"']obsidian[\"']" \
  $NON_PLUGIN_FILES

# --- Rule 2: no file inside packages/plugin reaches the network by any route
# other than @ccc/service-api-client. Widened in plan 03-01 from the former
# `node:http`/`node:https` import-only pattern, which was blind to the bare
# `http`/`https`/`node:net` specifiers, to the four network GLOBALS (which
# need no import at all), and to Obsidian's own `requestUrl` helper -- the
# plugin is the one element allowed to import `obsidian`, so nothing else in
# the gate could see it (ADR-0001, 03-RESEARCH.md Pitfall 3). ---
PLUGIN_FILES=$(printf '%s\n' "$SRC_FILES" | grep '^packages/plugin/' || true)
# shellcheck disable=SC2086
check_rule \
  "a file inside packages/plugin reaches the network directly (must speak only through @ccc/service-api-client)" \
  "from[[:space:]]*[\"'](node:)?https?[\"']|from[[:space:]]*[\"']node:net[\"']|(^|[^A-Za-z0-9_])(fetch|XMLHttpRequest|WebSocket|EventSource)[[:space:]]*[(]|new[[:space:]]+(XMLHttpRequest|WebSocket|EventSource)|(^|[^A-Za-z0-9_])requestUrl" \
  $PLUGIN_FILES

# --- Rule 3: nothing outside packages/service or packages/operational-store
# imports the SQLite binding ---
NON_SQLITE_OWNERS=$(printf '%s\n' "$SRC_FILES" | grep -v '^packages/service/' | grep -v '^packages/operational-store/' || true)
# shellcheck disable=SC2086
check_rule \
  "a file outside packages/service and packages/operational-store imports the better-sqlite3 binding" \
  "from[[:space:]]*[\"']better-sqlite3[\"']" \
  $NON_SQLITE_OWNERS

# --- Rule 4: nothing outside packages/keychain spawns the system security tool ---
NON_KEYCHAIN_FILES=$(printf '%s\n' "$SRC_FILES" | grep -v '^packages/keychain/' || true)
# shellcheck disable=SC2086
check_rule \
  "a file outside packages/keychain spawns the macOS security(1) tool directly" \
  "(execa|spawn|execFile|exec).[[:space:]]*[\"'](/usr/bin/)?security[\"']" \
  $NON_KEYCHAIN_FILES

# --- Rule 5: no file anywhere references a mail-transport module or SMTP
# client -- the product has no email-send surface at any layer, ever
# (GMAIL-08). The absence is asserted, not assumed. ---
# shellcheck disable=SC2086
check_rule \
  "a file references a mail-transport module or SMTP client -- no email-send surface may exist at any layer" \
  "(nodemailer|node-smtp|smtp-client|SMTPClient|SmtpClient|SMTP|Smtp|smtp)" \
  $SRC_FILES

# --- Rule 6: no file inside packages/plugin uses a DOM HTML-injection sink.
# Obsidian's plugin guidelines forbid them outright, and untrusted widget
# text (mail subjects, issue titles, headlines) is exactly what this phase
# starts rendering. eslint-plugin-obsidianmd ships NO innerHTML rule, so
# before plan 03-01 neither layer of this gate could see it. ---
# shellcheck disable=SC2086
check_rule \
  "a file inside packages/plugin uses a DOM HTML-injection sink (use createEl() or JSX so untrusted text is escaped)" \
  "(inner|outer)HTML[[:space:]]*=|insertAdjacentHTML|dangerouslySetInnerHTML" \
  $PLUGIN_FILES

# --- Rule 7: no file inside packages/plugin assigns an inline style. State
# reaches CSS through data-* attributes and --ccc-* custom properties
# (UI-03), never a style assignment or a style prop -- which is also what
# keeps the plugin's visuals inside the command-center root container rather
# than overriding Obsidian's shared chrome. ---
# shellcheck disable=SC2086
check_rule \
  "a file inside packages/plugin assigns an inline style (use a class and a --ccc-* token; state reaches CSS through data-* attributes)" \
  "[.]style[.][A-Za-z]+[[:space:]]*=|[.]style[[:space:]]*=[^=]|setAttribute[(][[:space:]]*[\"']style[\"']|[[:space:]]style=[{]" \
  $PLUGIN_FILES

# --- Rule 8: no file in packages/launchers or packages/service starts a
# process through a shell (D-18, PROJ-13). A project path or command
# template that reaches a shell string is an injection; every spawn in the
# two packages that start processes must be execFile/spawn with an argv
# array and no `shell` option. The `.` in the negated class keeps a method
# call such as a RegExp's or a SQLite handle's `.exec(` from tripping the
# rule -- only a bare `exec(`/`execSync(` (the child_process import) does.
# A `shell` key (bare or double-quoted) followed by any value that does not
# begin with the word `false` trips the rule: `true`, a shell path and a
# variable all run a shell. ERE has no negative lookahead, so "not false"
# is spelled out prefix by prefix. A dynamic `import(` of child_process is
# refused outright, which also covers `(await import(...)).exec(`: the
# method call there is preceded by `.`, so the bare-call alternative cannot
# see it. The lint sees import shapes; this sees the call text. ---
SPAWN_OWNER_FILES=$(printf '%s\n' "$SRC_FILES" | grep -E '^packages/(launchers|service)/' || true)
RULE8_BARE_EXEC='(^|[^A-Za-z0-9_.])(exec|execSync)[(]'
RULE8_SHELL_OPTION='(^|[^A-Za-z0-9_.])["]?shell["]?[[:space:]]*:[[:space:]]*([^f[:space:]]|f[^a]|fa[^l]|fal[^s]|fals[^e]|false[A-Za-z0-9_])'
RULE8_DYNAMIC_IMPORT='(^|[^A-Za-z0-9_.])import[(][[:space:]]*[^A-Za-z0-9_[:space:]](node:)?child_process'
# shellcheck disable=SC2086
check_rule \
  "a file in packages/launchers or packages/service starts a process through a shell (use execFile/spawn with an argv array and no shell option, D-18)" \
  "${RULE8_BARE_EXEC}|${RULE8_SHELL_OPTION}|${RULE8_DYNAMIC_IMPORT}" \
  $SPAWN_OWNER_FILES

# --- Rule 9: no file inside packages/service, packages/collectors or
# packages/plugin sends the interrupt signal to a process (PR-01, SESS-16).
# Signalled, it ends an interactive Claude Code session instead of
# interrupting the turn, so "interrupt" is focus plus Esc (PR-27) and no code
# may ever send it: by name or as the bare number 2 in a kill call; held in a
# variable or constant (any quoted signal name, `os.constants.signals.`);
# or as a kill(1) flag through execFile (`-INT`, `-SIGINT`, `-2`,
# `-s INT`) (wave 5 review). Receiving it (the service's own shutdown
# handler, `process.on`/`once`) is not a send and stays allowed. The plugin
# has no process-launching path today; the scan is cheap and closes the gap
# if Electron process access is ever used there. ---
SIGNAL_OWNERS=$(printf '%s\n' "$SRC_FILES" | grep -E '^packages/(service|collectors|plugin)/' || true)
# shellcheck disable=SC2086
kill_hits=$(grep_noncomment \
  "kill[[:space:]]*[(][^)]*SIGINT|kill[[:space:]]*[(][^)]*,[[:space:]]*2[[:space:]]*[)]|signals[.]SIGINT|[\"'\`]-(INT|SIGINT|2)[\"'\`]|[\"'\`]-s[\"'\`][[:space:]]*,[[:space:]]*[\"'\`](INT|SIGINT|2)[\"'\`]" \
  $SIGNAL_OWNERS || true)
# shellcheck disable=SC2086
held_hits=$(grep_noncomment "[\"'\`]SIGINT[\"'\`]" $SIGNAL_OWNERS |
  grep -Ev "process[.](on|once|addListener|prependListener|prependOnceListener|off|removeListener)[[:space:]]*[(][[:space:]]*[\"'\`]SIGINT" || true)
report_rule \
  "a file sends the interrupt signal to a process (PR-01: it ends a Claude Code session; interrupt is focus plus Esc)" \
  "$(printf '%s\n%s\n' "$kill_hits" "$held_hits" | grep -v '^$' | sort -u || true)"

# --- Rule 10: no non-test file forges a CapabilityToken (PR-26, ADR-0012,
# PATTERNS correction 4). A write method typed on a capability is only a
# choke point while nothing but the approval engine can produce one. The
# ways around the type are all refused outside tests: a cast (`as
# CapabilityToken`, `<CapabilityToken>`); a typed initializer (`const t:
# CapabilityToken<...> = ...`); JSON.parse fed straight to terminate(); and,
# in any file that names CapabilityToken or SessionTerminator, `any` in any
# form (wave 5 review). Tests may cast locally to exercise a
# capability-typed method, so files named *.test.* are exempt.
#
# The approval engine has to produce a token somewhere, so the forgery scan
# (and ONLY the forgery scan) skips exactly one path, MINTER_PATH: the
# engine's minter file (D-02, T-06-01). The skip is a whole-line match
# anchored at both ends (`^...$`, the dot as `[.]`), so a path that merely
# contains the minter path, starts with it, or ends with it is still scanned
# (judge-r1 finding 9). The `any` scan below keeps the minter file in its
# list, so the carve-out removes the cast pattern for that one file and nothing
# else. ---
MINTER_PATH_PATTERN='^packages/service/src/approval/mint/mint-token[.]ts$'
NON_TEST_FILES=$(printf '%s\n' "$SRC_FILES" | grep -v '[.]test[.]' || true)
FORGERY_SCAN_FILES=$(printf '%s\n' "$NON_TEST_FILES" | grep -v "$MINTER_PATH_PATTERN" || true)
# shellcheck disable=SC2086
forge_hits=$(grep_noncomment \
  "(^|[^A-Za-z0-9_])as[[:space:]]+CapabilityToken|[=(,][[:space:]]*<CapabilityToken|:[[:space:]]*CapabilityToken[[:space:]]*<[^>]*>[[:space:]]*=[^=>]|terminate[[:space:]]*[(][[:space:]]*JSON[.]parse" \
  $FORGERY_SCAN_FILES || true)
CAPABILITY_FILES=""
for f in $NON_TEST_FILES; do
  [ -f "$f" ] || continue
  if grep -Eq 'CapabilityToken|SessionTerminator' "$f"; then
    CAPABILITY_FILES="$CAPABILITY_FILES $f"
  fi
done
any_hits=""
if [ -n "$CAPABILITY_FILES" ]; then
  # shellcheck disable=SC2086
  any_hits=$(grep_noncomment \
    "(^|[^A-Za-z0-9_])as[[:space:]]+any([^A-Za-z0-9_]|$)|<any>|:[[:space:]]*any([^A-Za-z0-9_]|$)" \
    $CAPABILITY_FILES || true)
fi
report_rule \
  "a non-test file forges a CapabilityToken (a cast, typed initializer, JSON.parse or any; only the approval engine issues one, and its minter file packages/service/src/approval/mint/mint-token.ts is the single path allowed to cast; tests may cast locally)" \
  "$(printf '%s\n%s\n' "$forge_hits" "$any_hits" | grep -v '^$' | sort -u || true)"

# --- Rule 11: nothing outside packages/service/src/approval/ imports the
# approval minter (D-03, T-06-01, T-06-15). The minter is the one file that can
# produce a capability token, so reaching it from anywhere but the engine's own
# folder is a forgery path even though the cast itself is carved out of rule 10.
# SPECIFIER_HEAD matches the start of any module specifier: `from "`, a
# side-effect `import "`, or a dynamic `import("` / `require("`. The folder test
# is on the specifier text (`approval/mint` followed by a slash or the closing
# quote), because a file outside the folder has to name the folder to reach it.
# Test files are not in NON_TEST_FILES. ---
SPECIFIER_HEAD="(from|import|require)[[:space:]]*[(]?[[:space:]]*[\"'\`][^\"'\`]*"
OUTSIDE_APPROVAL_FILES=$(printf '%s\n' "$NON_TEST_FILES" | grep -v '^packages/service/src/approval/' || true)
# shellcheck disable=SC2086
check_rule \
  "a file outside packages/service/src/approval/ imports the approval minter (a specifier containing approval/mint; only the engine's own folder may reach it, T-06-01)" \
  "${SPECIFIER_HEAD}approval/mint(/|[\"'\`])" \
  $OUTSIDE_APPROVAL_FILES

# --- Rule 12: nothing outside packages/service/src/executors/ and the
# composition root packages/service/src/main.ts imports an executor (D-03,
# T-06-02, T-06-15). Executors are effect code; a route or the engine reaching
# one directly skips the approval gate, so they are wired only at startup. The
# specifier must have a slash directly before `executors`, so a look-alike such
# as `not-executors/` or `executors-extra/` is not a hit. ---
OUTSIDE_EXECUTORS_FILES=$(printf '%s\n' "$NON_TEST_FILES" | grep -v '^packages/service/src/executors/' | grep -v '^packages/service/src/main[.]ts$' || true)
# shellcheck disable=SC2086
check_rule \
  "a file outside packages/service/src/executors/ and packages/service/src/main.ts imports an executor (a specifier reaching the executors folder; effect code is wired only by the composition root, T-06-02)" \
  "${SPECIFIER_HEAD}/executors(/|[\"'\`])" \
  $OUTSIDE_EXECUTORS_FILES

# --- Rule 13: no file outside packages/service/src/claude/ calls process.kill(
# (D-03, T-06-02). The two existing sites (the process-existence probe and the
# terminate executor's kill callback) live in claude/services.ts; anything else
# that signals a process is a way around the approval engine. The boundary
# character before `process` excludes a longer identifier such as `subprocess`
# but still sees `globalThis.process.kill(`. ---
OUTSIDE_CLAUDE_FILES=$(printf '%s\n' "$NON_TEST_FILES" | grep -v '^packages/service/src/claude/' || true)
# shellcheck disable=SC2086
check_rule \
  "a file outside packages/service/src/claude/ calls process.kill( (only the Claude services may signal a process, T-06-02)" \
  "(^|[^A-Za-z0-9_])process[.]kill[[:space:]]*[(]" \
  $OUTSIDE_CLAUDE_FILES

# --- Rule 14: no file outside packages/service/src/executors/ calls
# .terminate( (D-03, T-06-02). Only a call with a leading dot is a hit (also
# `?.terminate(`), so the Phase 5 method definition and interface member named
# terminate, which have no leading dot, are not. ---
NON_EXECUTOR_FILES=$(printf '%s\n' "$NON_TEST_FILES" | grep -v '^packages/service/src/executors/' || true)
# shellcheck disable=SC2086
check_rule \
  "a file outside packages/service/src/executors/ calls .terminate( (only the executors may invoke the session terminator, T-06-02)" \
  "[.]terminate[[:space:]]*[(]" \
  $NON_EXECUTOR_FILES

# --- Rule 15: the approval engine's public door, packages/service/src/approval/
# index.ts, never references the minter (review MAJOR-2, T-06-01). Every service
# file may import the door, so a door that imports or re-exports the minter
# (`export * from "./mint/mint-token.js"`) would hand it to all of them; rule
# 11 cannot see this because the door lives inside the approval folder. Any
# non-comment line mentioning `mint/` in that one file is a hit. ---
DOOR_FILES=$(printf '%s\n' "$NON_TEST_FILES" | grep -E '^packages/service/src/approval/index[.](ts|mts|cts)$' || true)
# shellcheck disable=SC2086
check_rule \
  "the approval public door (packages/service/src/approval/index.ts) references the minter (the public door must never import or re-export approval/mint, T-06-01)" \
  "mint/|mint-token" \
  $DOOR_FILES

FILE_COUNT=$(printf '%s\n' "$SRC_FILES" | grep -c . || true)
echo "scripts/check-boundaries.sh: checked ${RULES} rules."
echo "scripts/check-boundaries.sh: scanned ${FILE_COUNT} tracked source files, ${FAILURES} rule(s) violated."

if [ "$FAILURES" -gt 0 ]; then
  exit 1
fi
exit 0
