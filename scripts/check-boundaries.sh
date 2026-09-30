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
#   8. no file inside packages/service, packages/collectors or
#      packages/plugin sends the interrupt signal to a process (PR-01)
#   9. no non-test file casts to the CapabilityToken type -- only the
#      approval engine issues one (ADR-0012, PR-26)
#
# Rules 6 and 7 mirror DOM_SAFETY_RULES, and rule 2 mirrors
# NETWORK_ISOLATION_RULES, in packages/plugin/eslint.config.mjs. The
# duplication is the point: this script is the layer that still reports when
# the lint's config silently stops matching.
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
  RULES=$((RULES + 1))
  hits=$(grep_noncomment "$pattern" "$@" || true)
  if [ -n "$hits" ]; then
    echo "BOUNDARY VIOLATION: $description"
    echo "$hits"
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

# --- Rule 8: no file inside packages/service, packages/collectors or
# packages/plugin sends the interrupt signal to a process (PR-01, SESS-16).
# Signalled, it ends an interactive Claude Code session instead of
# interrupting the turn, so "interrupt" is focus plus Esc (PR-27) and no code
# may ever send it -- by name, or as the bare number 2. Receiving it (the
# service's own shutdown handler) is not a kill call and stays allowed. The
# plugin has no process-launching path today; the scan is cheap and closes
# the gap if Electron process access is ever used there. ---
SIGNAL_OWNERS=$(printf '%s\n' "$SRC_FILES" | grep -E '^packages/(service|collectors|plugin)/' || true)
# shellcheck disable=SC2086
check_rule \
  "a file sends the interrupt signal to a process (PR-01: it ends a Claude Code session; interrupt is focus plus Esc)" \
  "kill[[:space:]]*[(][^)]*SIGINT|kill[[:space:]]*[(][^)]*,[[:space:]]*2[[:space:]]*[)]" \
  $SIGNAL_OWNERS

# --- Rule 9: no non-test file casts to the CapabilityToken type (PR-26,
# ADR-0012, PATTERNS correction 4). A write method typed on a capability is
# only a choke point while nothing but the approval engine can produce one;
# a cast is the one way around the type. Tests may cast locally to exercise
# a capability-typed method, so files named *.test.* are exempt. ---
NON_TEST_FILES=$(printf '%s\n' "$SRC_FILES" | grep -v '[.]test[.]' || true)
# shellcheck disable=SC2086
check_rule \
  "a non-test file casts to CapabilityToken (only the approval engine issues one; tests may cast locally)" \
  "(^|[^A-Za-z0-9_])as[[:space:]]+CapabilityToken|[=(,][[:space:]]*<CapabilityToken" \
  $NON_TEST_FILES

FILE_COUNT=$(printf '%s\n' "$SRC_FILES" | grep -c . || true)
echo "scripts/check-boundaries.sh: checked ${RULES} rules."
echo "scripts/check-boundaries.sh: scanned ${FILE_COUNT} tracked source files, ${FAILURES} rule(s) violated."

if [ "$FAILURES" -gt 0 ]; then
  exit 1
fi
exit 0
