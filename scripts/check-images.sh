#!/bin/sh
# Tracked-image allowlist gate (PRIV-04 verification chain, layer 3; threat
# T-03-03). Run in CI as `pnpm run ci:images`.
#
# Why a separate gate: `scripts/check-privacy.sh` reads TEXT. It cannot read
# the pixels of a PNG or the frames of a video (research Pitfall 8), so a
# screenshot of the owner's real vault, inbox or calendar would pass it
# untouched. PRIV-04 is therefore a chain, not a scan:
#   1. the visual harness may only import the synthetic fixtures
#      (packages/test-fixtures/src/harness-purity.test.ts);
#   2. ci:privacy clears the fixture TEXT that becomes pixels;
#   3. THIS gate: the only images git may track are the visual baselines, in
#      the one directory the pinned Linux container writes to;
#   4. the owner looks at every committed baseline (03-UAT.md item 10).
#
# The rule: every tracked image, document or video (IMAGE_EXTENSIONS below,
# any case — a screenshot can arrive as a phone's .heic, a scanner's .tiff or
# a printed .pdf just as easily as a .png) must
# be a direct child of ALLOWED_PREFIX and named `*-chromium-linux.png` — the
# only name Playwright gives a baseline written on Linux (D-22). Anything
# else, including a macOS `*-chromium-darwin.png` in the right directory, is a
# violation. `.gitignore` enforces the same allowlist at staging time; this
# gate is the half that also catches a force-add.
#
# The tracked-file walk is the NUL-safe one from check-privacy.sh: a filename
# containing a newline is refused outright rather than split into two paths
# that each escape the check. Prints one line per violation and a summary
# with the number of images scanned, so an empty scan is visible as "0".

set -eu

ALLOWED_PREFIX="packages/test-fixtures/visual/widgets.spec.ts-snapshots/"
BASELINE_SUFFIX="-chromium-linux.png"
# Every raster, vector and document format a screenshot or a scan of personal
# content can take, plus the video formats a screen recording can (judge-r1
# finding 3). Matched case-insensitively.
IMAGE_EXTENSIONS="png|jpg|jpeg|gif|webp|avif|heic|heif|tif|tiff|bmp|svg|pdf|ico|mp4|mov|webm"

FILELIST=$(mktemp "${TMPDIR:-/tmp}/ccc-image-files.XXXXXX")
trap 'rm -f "$FILELIST"' EXIT

NUL_COUNT=$(git ls-files -z | tr -cd '\0' | wc -c | tr -d ' ')
NL_COUNT=$(git ls-files | wc -l | tr -d ' ')
if [ "$NUL_COUNT" != "$NL_COUNT" ]; then
  echo "scripts/check-images.sh: FATAL: a tracked filename contains a newline; refusing to scan a splittable list." >&2
  exit 2
fi

# Self-excluded like check-privacy.sh excludes itself (this script is not an
# image, so the exclusion only guards against a future rename).
git ls-files -z | tr '\0' '\n' \
  | grep -v '^scripts/check-images\.sh$' \
  | grep -i -E "\\.(${IMAGE_EXTENSIONS})\$" > "$FILELIST" || true

SCANNED=0
VIOLATIONS=0
while IFS= read -r f; do
  SCANNED=$((SCANNED + 1))
  case "$f" in
    "$ALLOWED_PREFIX"*)
      name=${f#"$ALLOWED_PREFIX"}
      case "$name" in
        */*)
          echo "IMAGE OUTSIDE ALLOWLIST: $f (nested below the snapshot directory)"
          VIOLATIONS=$((VIOLATIONS + 1))
          ;;
        *"$BASELINE_SUFFIX")
          ;;
        *)
          echo "IMAGE OUTSIDE ALLOWLIST: $f (not a *${BASELINE_SUFFIX} baseline)"
          VIOLATIONS=$((VIOLATIONS + 1))
          ;;
      esac
      ;;
    *)
      echo "IMAGE OUTSIDE ALLOWLIST: $f"
      VIOLATIONS=$((VIOLATIONS + 1))
      ;;
  esac
done < "$FILELIST"

echo "scripts/check-images.sh: scanned ${SCANNED} tracked image(s), ${VIOLATIONS} outside the allowlist."

if [ "$VIOLATIONS" -gt 0 ]; then
  exit 1
fi
