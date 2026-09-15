#!/bin/sh
# Owner-denylist privacy scan (PRIV-01, PRIV-02). Every tracked file is
# scanned for:
#   1. an absolute macOS home-directory path whose user segment is a
#      real-looking name (excludes the documented placeholder segments
#      USERNAME, username, <username>, $USER, you -- 01-RESEARCH.md's
#      property-list example deliberately uses /Users/USERNAME/ and must not
#      be flagged);
#   2. an email address, excluding the reserved example domains
#      example.com / example.org / example.net;
#   3. every additional literal pattern listed one-per-line in
#      .privacy-denylist.local, when that file exists -- untracked and
#      gitignored, so the maintained list of the owner's real project names
#      and aliases never becomes the leak it exists to prevent.
#
# Rule 2 (email) is not applied to GSD planning documents
# (.planning/phases/**/*.md): a PLAN.md's own <verify> text routinely quotes
# a synthetic probe email as part of documenting a privacy-scanner test
# (exactly the SCANNER_DISCRIMINATES check in this plan's own Task 3), and
# every SUMMARY.md that narrates that deviation quotes the same string right
# back. Neither is the owner's real address or anyone else's -- it is
# scanner-test documentation, not leaked personal data. Rule 1 (home path)
# and Rule 3 (denylist) remain fully enforced on planning documents; only
# the generic email pattern is scoped away from them.
#
# Prints "path:line:content" for every hit and a summary line with the
# number of files scanned, so a run that silently matched nothing because
# the file list was empty is distinguishable from a genuinely clean run.

set -eu

VIOLATIONS=0

# This script's own source necessarily contains the pattern definitions
# above as prose/regex literals -- excluded from the scan so the rule's own
# definition can never trip the gate it defines.
FILES=$(git ls-files | grep -v '^scripts/check-privacy\.sh$' || true)

scan_file() {
  f="$1"
  check_email="$2"
  [ -f "$f" ] || return 0
  awk -v fname="$f" -v check_email="$check_email" '
    {
      line = $0
      violated = 0

      # --- Rule 1: absolute home-directory path with a real-looking user
      # segment. Loop over every /Users/<segment>/ occurrence on the line so
      # a placeholder segment does not mask a real one elsewhere on the
      # same line, and vice versa. ---
      rest = line
      while (match(rest, /\/Users\/[A-Za-z0-9._$<>-]+\//)) {
        seg = substr(rest, RSTART, RLENGTH)
        sub(/^\/Users\//, "", seg)
        sub(/\/$/, "", seg)
        if (seg != "USERNAME" && seg != "username" && seg != "<username>" && seg != "$USER" && seg != "you") {
          violated = 1
        }
        rest = substr(rest, RSTART + RLENGTH)
      }

      # --- Rule 2: email address, excluding the reserved example domains. ---
      if (check_email == "1") {
        rest = line
        while (match(rest, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)) {
          addr = substr(rest, RSTART, RLENGTH)
          if (addr !~ /@example\.(com|org|net)$/) {
            violated = 1
          }
          rest = substr(rest, RSTART + RLENGTH)
        }
      }

      if (violated) {
        print fname ":" NR ":" line
      }
    }
  ' "$f"
}

FILE_COUNT=0
for f in $FILES; do
  FILE_COUNT=$((FILE_COUNT + 1))
  case "$f" in
    .planning/phases/*/*.md) check_email=0 ;;
    *) check_email=1 ;;
  esac
  hits=$(scan_file "$f" "$check_email" || true)
  if [ -n "$hits" ]; then
    echo "$hits"
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
done

# --- Rule 3: the owner-maintained, untracked, gitignored denylist. ---
if [ -f .privacy-denylist.local ]; then
  while IFS= read -r pattern || [ -n "$pattern" ]; do
    case "$pattern" in
      ""|\#*) continue ;;
    esac
    for f in $FILES; do
      [ -f "$f" ] || continue
      hits=$(grep -nF -- "$pattern" "$f" 2>/dev/null | sed "s|^|$f:|" || true)
      if [ -n "$hits" ]; then
        echo "$hits"
        VIOLATIONS=$((VIOLATIONS + 1))
      fi
    done
  done < .privacy-denylist.local
fi

echo "scripts/check-privacy.sh: scanned ${FILE_COUNT} tracked files, ${VIOLATIONS} violation(s) found."

if [ "$VIOLATIONS" -gt 0 ]; then
  exit 1
fi
exit 0
