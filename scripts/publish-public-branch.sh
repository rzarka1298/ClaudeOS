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
#     git push public        # the `public` remote's push refspec maps public/main -> main (forced)
#
# Requires git-filter-repo (brew install git-filter-repo).
set -eu

REPO_ROOT="$(git rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Published commits carry the owner's GitHub NOREPLY address, never a real
# mailbox: the metadata guard below denylists the real address, so identity
# rewriting is a requirement of this projection, not a preference. The
# address is DERIVED at runtime from the `public` remote's GitHub URL --
# embedding an email-shaped literal here would itself trip ci:privacy.
PUBLIC_URL="$(git config remote.public.url || true)"
GH_USER="$(printf '%s' "$PUBLIC_URL" | sed -nE 's#.*github\.com[:/]+([^/]+)/.*#\1#p')"
if [ -z "$GH_USER" ]; then
  echo "ERROR: could not derive a GitHub username from remote.public.url ('$PUBLIC_URL')." >&2
  echo "       The noreply identity rewrite needs it — refusing to produce a public branch." >&2
  exit 1
fi
NOREPLY_EMAIL="${GH_USER}@users.noreply.github.com"

git clone --no-local -q "$REPO_ROOT" "$WORK/filter"
cd "$WORK/filter"

# The single list of paths this projection removes. Both the filter and the
# public .gitignore guard commit below are driven from it, so the two can
# never drift -- .obsidian and .gsd were previously stripped from history
# but ABSENT from the guard commit, leaving exactly the re-add the guard
# exists to prevent possible for two of the six paths.
STRIPPED_PATHS='.planning
.claude
.obsidian
.gsd
CONTEXT.md
claude-command-center-prd.md
PRIVACY-GATE-REPORT.md'

FILTER_ARGS=""
for path in $STRIPPED_PATHS; do
  FILTER_ARGS="$FILTER_ARGS --path $path"
done

# shellcheck disable=SC2086
git filter-repo --quiet --invert-paths $FILTER_ARGS \
  --email-callback "return b'${NOREPLY_EMAIL}'"

# Guard: no denylisted owner identifier may survive anywhere in the filtered
# history. Patterns live in the UNTRACKED .privacy-denylist.local so this
# script never embeds a leak-shaped string itself.
#
# This gate protects a LOCKED constraint ("the public repository must build
# and run from a clean clone with zero personal data"), so its default is
# refusal. A missing denylist, an unreadable one, or a `git grep` that
# failed for any reason other than "no match" all stop the publish -- the
# previous version warned and then printed the push command exactly as if
# the guard had passed, and `2>/dev/null` made a malformed pattern
# indistinguishable from a clean scan.
DENYLIST="$REPO_ROOT/.privacy-denylist.local"
if [ ! -f "$DENYLIST" ]; then
  echo "ERROR: $DENYLIST not found — refusing to produce a public branch." >&2
  echo "       Create it (one pattern per line) or delete this guard deliberately." >&2
  exit 1
fi

REVS="$(git rev-list --all)"
if [ -z "$REVS" ]; then
  echo "ERROR: filtered history is empty — refusing to produce a public branch." >&2
  exit 1
fi

# Failures name the denylist LINE NUMBER, never the pattern: the whole
# reason the list is untracked is that the patterns are themselves the
# sensitive strings, and a CI log is not a safe place to print one.
line_no=0
while IFS= read -r pattern; do
  line_no=$((line_no + 1))
  case "$pattern" in ''|'#'*) continue;; esac

  # Content of every blob in every rewritten commit. `git grep` exits 0 on a
  # match, 1 on no match, and >1 on an ERROR (a malformed ERE, for one) --
  # so the three are distinguished rather than collapsed into a boolean.
  set +e
  # shellcheck disable=SC2086
  git grep -qE -- "$pattern" $REVS
  grep_status=$?
  set -e
  if [ "$grep_status" -eq 0 ]; then
    echo "ERROR: denylist line $line_no matches filtered CONTENT — refusing." >&2
    exit 1
  fi
  if [ "$grep_status" -ne 1 ]; then
    echo "ERROR: git grep failed (exit $grep_status) on denylist line $line_no — refusing." >&2
    echo "       A pattern that cannot be evaluated is a pattern that is not enforced." >&2
    exit 1
  fi

  # Commit METADATA. `git grep` only ever searches tracked blobs, so commit
  # messages and the author/committer name and email on every commit were
  # never inspected at all -- and `git filter-repo` is not asked to rewrite
  # identities here, so the owner's git identity ships in every commit of
  # the published branch unless something checks for it.
  if git log --all --format='%an%n%ae%n%cn%n%ce%n%B' | grep -qE -- "$pattern"; then
    echo "ERROR: denylist line $line_no matches commit METADATA — refusing." >&2
    echo "       Rewrite the offending messages or identities before publishing." >&2
    exit 1
  fi
done < "$DENYLIST"

# Public-branch guard commit: make the stripped paths ignored for anyone
# working from the public repo, so they can never be re-added by accident.
# Driven from STRIPPED_PATHS so the guard covers every path the filter
# removed, not a hand-maintained subset of them.
{
  printf '\n# Internal planning artifacts — never tracked in the public repo\n'
  for path in $STRIPPED_PATHS; do
    case "$path" in
      *.md) printf '%s\n' "$path" ;;
      *) printf '%s/\n' "$path" ;;
    esac
  done
} >> .gitignore
git add .gitignore
# The guard commit is created AFTER the identity rewrite and AFTER the
# metadata guard ran, so it must set the noreply identity explicitly —
# otherwise the branch tip re-introduces the real address the guard exists
# to keep out.
git -c user.email="$NOREPLY_EMAIL" commit -q -m "chore: guard internal paths in public .gitignore"

cd "$REPO_ROOT"
git fetch -f -q "$WORK/filter" HEAD:public/main
echo "public/main regenerated at $(git rev-parse --short refs/heads/public/main)"
echo "Publish with: git push public   # refspec maps public/main -> main (forced)"
