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
#      through a shell (exec/execSync, shell: true) -- D-18
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

# --- Rule 8: no file in packages/launchers or packages/service starts a
# process through a shell (D-18, PROJ-13). A project path or command
# template that reaches a shell string is an injection; every spawn in the
# two packages that start processes must be execFile/spawn with an argv
# array and no `shell` option. The `.` in the negated class keeps a method
# call such as a RegExp's or a SQLite handle's `.exec(` from tripping the
# rule -- only a bare `exec(`/`execSync(` (the child_process import) does.
# The lint sees import shapes; this sees the call text. ---
SPAWN_OWNER_FILES=$(printf '%s\n' "$SRC_FILES" | grep -E '^packages/(launchers|service)/' || true)
# shellcheck disable=SC2086
check_rule \
  "a file in packages/launchers or packages/service starts a process through a shell (use execFile/spawn with an argv array and no shell option, D-18)" \
  "(^|[^A-Za-z0-9_.])(exec|execSync)[(]|shell:[[:space:]]*true" \
  $SPAWN_OWNER_FILES

FILE_COUNT=$(printf '%s\n' "$SRC_FILES" | grep -c . || true)
echo "scripts/check-boundaries.sh: scanned ${FILE_COUNT} tracked source files, ${FAILURES} rule(s) violated."

if [ "$FAILURES" -gt 0 ]; then
  exit 1
fi
exit 0
