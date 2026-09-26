#!/bin/sh
# Run the visual-regression job (UI-08) locally, byte-for-byte the way CI runs
# it: inside the pinned Playwright Linux container (D-22, ADR-0023 "Screenshot
# platform").
#
# Usage:
#   sh scripts/ci/visual-in-container.sh                     compare against the committed baselines
#   sh scripts/ci/visual-in-container.sh --update-snapshots  regenerate them, then copy them back
#
# Why a container: font rasterisation differs between macOS and Linux, so a
# baseline is only reproducible if everyone renders in the same image. The
# image tag is pinned to the exact @playwright/test version in the lockfile
# (1.63.0): the image ships the matching Chromium build, and a Playwright bump
# must move the tag with it — and regenerate every baseline in its own commit.
#
# Why linux/amd64: CI's ubuntu-latest runner is x86_64. On an Apple-silicon Mac
# the image would otherwise run as arm64, a second rendering target; Docker
# Desktop emulates amd64 instead, slower but the same pixels as CI.
#
# Why a copy, never the host checkout: the working tree is rsync-copied
# (minus .git, node_modules, every build output and private local files) into
# a temp dir that the container mounts READ-ONLY. Inside, the tree is copied
# again onto the container's own filesystem, dependencies are installed there
# and the job runs there — so the host's node_modules, its macOS-built native
# modules and its dist/ are never read or written. The only thing that comes
# back is the snapshot directory, and only with --update-snapshots after a
# green run (plus Playwright's diff output under test-results/, which is
# gitignored, when a comparison fails).
#
# Why --ignore-scripts: the visual job never executes service code, so no
# native module is built; esbuild and turbo resolve their platform binaries
# from their optional packages without a postinstall.
#
# CCC_VISUAL_CONTAINER=1 is the marker playwright.config.ts requires (together
# with Linux and the image's /ms-playwright browser path) before it will accept
# --update-snapshots. Baseline updates land as standalone commits with a
# justification (research Pitfall 5; scripts/ci/README.md).

set -eu

IMAGE="mcr.microsoft.com/playwright:v1.63.0-noble"
PLATFORM="linux/amd64"
SNAPSHOTS="packages/test-fixtures/visual/widgets.spec.ts-snapshots"

UPDATE=0
for arg in "$@"; do
  case "$arg" in
    --update-snapshots) UPDATE=1 ;;
    -h | --help)
      sed -n '2,9p' "$0"
      exit 0
      ;;
    *)
      echo "scripts/ci/visual-in-container.sh: unknown argument: $arg (only --update-snapshots is accepted)" >&2
      exit 2
      ;;
  esac
done

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "scripts/ci/visual-in-container.sh: docker is not available — start Docker Desktop (docker info must succeed)." >&2
  exit 2
fi

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/ccc-visual.XXXXXX")
trap 'rm -rf "$WORK"' EXIT INT TERM
mkdir "$WORK/tree" "$WORK/out"

echo "scripts/ci/visual-in-container.sh: image $IMAGE ($PLATFORM)"
echo "scripts/ci/visual-in-container.sh: copying $REPO_ROOT -> $WORK/tree (excluding build output and local files)"

# The clean-tree-check.sh exclusions, plus: nested agent worktrees, the
# planning tree, Playwright's own output, and every gitignored private file.
rsync -a \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.turbo' \
  --exclude 'dist' \
  --exclude '*.tsbuildinfo' \
  --exclude 'packages/plugin/main.js' \
  --exclude 'packages/plugin/styles.css' \
  --exclude '.claude/worktrees' \
  --exclude '.planning' \
  --exclude 'test-results' \
  --exclude 'playwright-report' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude '.privacy-denylist.local' \
  --exclude 'reference.local.*' \
  "$REPO_ROOT/" "$WORK/tree/"

STATUS=0
docker run --rm --init --ipc=host --platform "$PLATFORM" \
  -e CCC_VISUAL_CONTAINER=1 \
  -e CCC_UPDATE="$UPDATE" \
  -e CCC_SNAPSHOTS="$SNAPSHOTS" \
  -e HOST_UID="$(id -u)" \
  -e HOST_GID="$(id -g)" \
  -v "$WORK/tree":/src:ro \
  -v "$WORK/out":/out \
  "$IMAGE" sh -c '
    set -eu
    mkdir /work
    cp -a /src/. /work/
    cd /work
    corepack enable
    corepack prepare pnpm@11.24.0 --activate
    pnpm install --frozen-lockfile --ignore-scripts
    status=0
    if [ "$CCC_UPDATE" = 1 ]; then
      pnpm run ci:visual --update-snapshots || status=$?
    else
      pnpm run ci:visual || status=$?
    fi
    mkdir -p /out/snapshots
    if [ -d "$CCC_SNAPSHOTS" ]; then cp -a "$CCC_SNAPSHOTS/." /out/snapshots/; fi
    if [ -d test-results ]; then cp -a test-results /out/test-results; fi
    chown -R "$HOST_UID:$HOST_GID" /out
    exit "$status"
  ' || STATUS=$?

if [ "$STATUS" -eq 0 ] && [ "$UPDATE" -eq 1 ]; then
  mkdir -p "$REPO_ROOT/$SNAPSHOTS"
  rsync -a --delete "$WORK/out/snapshots/" "$REPO_ROOT/$SNAPSHOTS/"
  echo "scripts/ci/visual-in-container.sh: baselines copied back to $SNAPSHOTS — commit them ALONE, with a justification."
fi

if [ "$STATUS" -ne 0 ] && [ -d "$WORK/out/test-results" ]; then
  mkdir -p "$REPO_ROOT/test-results"
  rm -rf "$REPO_ROOT/test-results/visual-in-container"
  cp -R "$WORK/out/test-results" "$REPO_ROOT/test-results/visual-in-container"
  echo "scripts/ci/visual-in-container.sh: Playwright diff output kept in test-results/visual-in-container/ (gitignored)."
fi

echo "scripts/ci/visual-in-container.sh: copy $WORK (removed on exit), container exited ${STATUS}."
exit "$STATUS"
