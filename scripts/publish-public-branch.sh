#!/bin/sh
# Regenerate the public release branch (public/main) from the full local
# history, with internal planning artifacts filtered out of every commit.
#
# The local `main` branch is the private source of truth (it tracks
# .planning/, the PRD, and agent config so the development workflow keeps
# functioning). The public GitHub `main` is always a filtered projection
# produced by this script. Publish with:
#
#     sh scripts/publish-public-branch.sh
#     git push --force origin public/main:main
#
# Requires git-filter-repo (brew install git-filter-repo).
set -eu

REPO_ROOT="$(git rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git clone --no-local -q "$REPO_ROOT" "$WORK/filter"
cd "$WORK/filter"

git filter-repo --quiet --invert-paths \
  --path .planning \
  --path .claude \
  --path .obsidian \
  --path .gsd \
  --path CONTEXT.md \
  --path claude-command-center-prd.md \
  --path PRIVACY-GATE-REPORT.md

# Guard: no denylisted owner identifier may survive anywhere in the filtered
# history. Patterns live in the UNTRACKED .privacy-denylist.local so this
# script never embeds a leak-shaped string itself.
DENYLIST="$REPO_ROOT/.privacy-denylist.local"
if [ -f "$DENYLIST" ]; then
  while IFS= read -r pattern; do
    case "$pattern" in ''|'#'*) continue;; esac
    for rev in $(git rev-list --all); do
      if git grep -qE "$pattern" "$rev" -- 2>/dev/null; then
        echo "ERROR: denylisted pattern '$pattern' present in filtered history at $rev" >&2
        exit 1
      fi
    done
  done < "$DENYLIST"
else
  echo "WARNING: $DENYLIST not found — identifier guard skipped." >&2
fi

# Public-branch guard commit: make the stripped paths ignored for anyone
# working from the public repo, so they can never be re-added by accident.
printf '\n# Internal planning artifacts — never tracked in the public repo\n.planning/\n.claude/\nCONTEXT.md\nclaude-command-center-prd.md\nPRIVACY-GATE-REPORT.md\n' >> .gitignore
git add .gitignore
git commit -q -m "chore: guard internal paths in public .gitignore"

cd "$REPO_ROOT"
git fetch -f -q "$WORK/filter" HEAD:public/main
echo "public/main regenerated at $(git rev-parse --short public/main)"
echo "Publish with: git push --force origin public/main:main"
