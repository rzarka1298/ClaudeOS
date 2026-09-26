#!/bin/sh
# Regenerate the public projection of every published branch (`main` and
# every `phase-*` branch) from the full local history, with internal planning
# artifacts filtered out of every commit.
#
# The local branches are the private source of truth (they track .planning/,
# the PRD, and agent config so the development workflow keeps functioning).
# Every branch on GitHub is a filtered projection produced by this script,
# stored locally under refs/public/<branch>. Publish with:
#
#     sh scripts/publish-public-branch.sh           # regenerate refs/public/*
#     sh scripts/publish-public-branch.sh --push    # regenerate, then force-push
#                                                   # refs/public/<b> -> <b> on `public`
#
# Agents never run `git push` directly (it is denied); `--push` is the only
# path to GitHub, so every push goes through the filter and the guards below.
# Works from the main checkout or any worktree of it.
#
# Requires git-filter-repo (brew install git-filter-repo).
set -eu

PUSH=0
case "${1:-}" in
  '') ;;
  --push) PUSH=1 ;;
  *) echo "usage: $0 [--push]" >&2; exit 2 ;;
esac

# The main checkout, even when run from a worktree: the untracked denylist
# lives there, and worktrees share its refs.
REPO_ROOT="$(cd "$(git rev-parse --path-format=absolute --git-common-dir)/.." && pwd)"
WORK="$(mktemp -d)"

# Two phase agents may publish at once; each run re-projects every branch,
# so serializing them is enough to keep refs/public/* consistent.
LOCK="$REPO_ROOT/.git/ccc-publish.lock"
tries=0
until mkdir "$LOCK" 2>/dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -ge 120 ]; then
    echo "ERROR: another publish holds $LOCK for over 10 minutes — refusing." >&2
    echo "       Remove it by hand if no publish is running." >&2
    rm -rf "$WORK"
    exit 1
  fi
  sleep 5
done
trap 'rm -rf "$WORK"; rmdir "$LOCK" 2>/dev/null || true' EXIT

# Published branches: main plus every phase-N branch. Agent scratch branches
# (worktree-agent-*) and the projection refs themselves are never published.
BRANCHES="$(git -C "$REPO_ROOT" for-each-ref --format='%(refname:short)' refs/heads/main 'refs/heads/phase-*')"
if [ -z "$BRANCHES" ]; then
  echo "ERROR: no main or phase-* branches found — refusing." >&2
  exit 1
fi

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
# GH_USER is spliced into the Python expression git-filter-repo evaluates for
# --email-callback below, so a quote in it would end the bytes literal and run
# the rest of the remote URL as Python (judge-r1 finding 8). GitHub usernames
# are letters, digits and hyphens only; anything else is refused before any
# clone or filter runs. A `case` over an explicit ASCII alphabet, not a grep:
# `grep -q` passes a multi-line value if any ONE line matches, and a bracket
# range can admit non-ASCII letters under a non-C locale. This is exactly
# ^[A-Za-z0-9-]+$ over the whole value.
case "$GH_USER" in
  '' | *[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-]*)
    echo "ERROR: '$GH_USER' (from remote.public.url) is not a valid GitHub username" >&2
    echo "       (letters, digits and hyphens only) — refusing to produce a public branch." >&2
    exit 1
    ;;
esac
NOREPLY_EMAIL="${GH_USER}@users.noreply.github.com"

git clone --no-local -q "$REPO_ROOT" "$WORK/filter"
cd "$WORK/filter"

# Materialize every published branch locally and drop the clone's remote, so
# filter-repo rewrites exactly these branches and nothing else. The clone is
# then no longer "fresh" in filter-repo's sense, hence --force below.
for b in $BRANCHES; do
  git update-ref "refs/heads/$b" "refs/remotes/origin/$b"
done
git config --remove-section remote.origin
git for-each-ref --format='%(refname)' refs/remotes | while IFS= read -r ref; do
  git update-ref -d "$ref"
done

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
git filter-repo --quiet --force --invert-paths $FILTER_ARGS \
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

# Public-branch guard commit, one per branch: make the stripped paths ignored
# for anyone working from the public repo, so they can never be re-added by
# accident. Driven from STRIPPED_PATHS so the guard covers every path the
# filter removed, not a hand-maintained subset of them.
#
# The guard commit is created AFTER the identity rewrite and AFTER the
# metadata guard ran, so it must set the noreply identity explicitly —
# otherwise the branch tip re-introduces the real address the guard exists
# to keep out.
for b in $BRANCHES; do
  git checkout -q -f "$b"
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
  git -c user.email="$NOREPLY_EMAIL" commit -q -m "chore: guard internal paths in public .gitignore"
done

cd "$REPO_ROOT"
REFSPECS=""
for b in $BRANCHES; do
  git fetch -f -q "$WORK/filter" "refs/heads/$b:refs/public/$b"
  echo "refs/public/$b regenerated at $(git rev-parse --short "refs/public/$b")"
  REFSPECS="$REFSPECS +refs/public/$b:refs/heads/$b"
done

if [ "$PUSH" -eq 1 ]; then
  # Forced: each public branch is a projection, regenerated whole every run.
  # shellcheck disable=SC2086
  git push -q public $REFSPECS
  echo "Pushed to public:$(printf ' %s' $BRANCHES)"
else
  echo "Publish with: sh scripts/publish-public-branch.sh --push"
fi
