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
#   3. THIS gate: the only images git may track are the visual baselines the
#      Playwright tests declare, in the one directory the pinned Linux
#      container writes to;
#   4. the owner looks at every committed baseline (03-UAT.md item 10).
#
# The rule. Every tracked image, document or video (IMAGE_EXTENSIONS below,
# any case — a screenshot can arrive as a phone's .heic, a scanner's .tiff or
# a printed .pdf just as easily as a .png) must sit exactly ONE directory
# level below ALLOWED_PREFIX (a `{specFile}-snapshots/` directory — one per
# `packages/test-fixtures/visual/*.spec.ts` file, since Playwright's own
# `{testFileName}` snapshotPathTemplate token gives each spec file its own
# directory, 05-13 Task 3) AND be on the EXPECTED list: the exact baseline
# paths `scripts/list-visual-baselines.mjs` derives from the tests themselves
# (`playwright test --list`, one `baseline` annotation per screenshot cell).
# The directory is never the source of truth (judge-r1 finding 1): a vault
# screenshot renamed `something-chromium-linux.png` is an ORPHAN, not a
# baseline. Conversely every expected baseline must be tracked — a MISSING one
# fails too, so the set git tracks and the set the tests compare are equal.
# `.gitignore` admits only `*-chromium-linux.png` at staging time, per spec
# file's own snapshot directory; this gate is the half that also catches a
# force-add and a well-named impostor.
#
# Refusals (judge-r1 finding 4): a failing `git ls-files`, a failing or empty
# lister, and a scan of zero images while baselines are expected all fail the
# gate — an empty result is never a clean one.
#
# The lister needs the workspace built (the spec imports @ccc/plugin's dist),
# which is why `ci:images` builds first.
#
# The tracked-file walk is NUL-safe: a filename containing a newline is
# refused outright rather than split into two paths that each escape the
# check. Prints one line per violation and a summary with the number of
# images scanned.

set -eu

ALLOWED_PREFIX="packages/test-fixtures/visual/"
LISTER="scripts/list-visual-baselines.mjs"
# Every raster, vector and document format a screenshot or a scan of personal
# content can take, plus the video formats a screen recording can (judge-r1
# finding 3). Matched case-insensitively.
IMAGE_EXTENSIONS="png|jpg|jpeg|gif|webp|avif|heic|heif|tif|tiff|bmp|svg|pdf|ico|mp4|mov|webm"

ZLIST=$(mktemp "${TMPDIR:-/tmp}/ccc-image-z.XXXXXX")
FILELIST=$(mktemp "${TMPDIR:-/tmp}/ccc-image-files.XXXXXX")
EXPECTED=$(mktemp "${TMPDIR:-/tmp}/ccc-image-expected.XXXXXX")
trap 'rm -f "$ZLIST" "$FILELIST" "$EXPECTED"' EXIT

# --- The tracked-file list. Captured to a file so git's own exit status is
# checked; inside a pipeline it was the last stage's status that counted. ---
if ! git ls-files -z > "$ZLIST"; then
  echo "scripts/check-images.sh: FATAL: git ls-files failed; refusing to report an unscanned tree as clean." >&2
  exit 2
fi
if [ "$(tr -cd '\n' < "$ZLIST" | wc -c | tr -d ' ')" != "0" ]; then
  echo "scripts/check-images.sh: FATAL: a tracked filename contains a newline; refusing to scan a splittable list." >&2
  exit 2
fi
tr '\0' '\n' < "$ZLIST" \
  | grep -v '^scripts/check-images\.sh$' \
  | grep -i -E "\\.(${IMAGE_EXTENSIONS})\$" > "$FILELIST" || true

# --- The expected set, from the tests. ---
if ! node "$LISTER" > "$EXPECTED"; then
  echo "scripts/check-images.sh: FATAL: could not derive the expected baselines from the visual tests ($LISTER failed); refusing to fall back to a name rule." >&2
  exit 2
fi
EXPECTED_COUNT=$(grep -c . "$EXPECTED" || true)
if [ "$EXPECTED_COUNT" -eq 0 ]; then
  echo "scripts/check-images.sh: FATAL: $LISTER declares no baselines; an empty allowlist cannot be enforced." >&2
  exit 2
fi

is_expected() {
  grep -qxF -- "$1" "$EXPECTED"
}

is_tracked() {
  grep -qxF -- "$1" "$FILELIST"
}

SCANNED=0
VIOLATIONS=0
while IFS= read -r f; do
  SCANNED=$((SCANNED + 1))
  case "$f" in
    "$ALLOWED_PREFIX"*)
      # `$name` is now `{specFile}-snapshots/{baseline}.png` — exactly one
      # directory level below ALLOWED_PREFIX (one snapshot dir per spec
      # file, 05-13 Task 3). Zero slashes means it sits loose in `visual/`
      # itself; two or more means it is nested further than any spec file's
      # own snapshot dir — both are violations, only exactly one is valid.
      name=${f#"$ALLOWED_PREFIX"}
      slashes=$(printf '%s' "$name" | tr -cd '/' | wc -c | tr -d ' ')
      case "$slashes" in
        0)
          echo "IMAGE OUTSIDE ALLOWLIST: $f (not inside a *-snapshots directory)"
          VIOLATIONS=$((VIOLATIONS + 1))
          ;;
        1)
          if ! is_expected "$name"; then
            echo "ORPHAN BASELINE: $f (no visual test declares it; only the names $LISTER prints may be tracked)"
            VIOLATIONS=$((VIOLATIONS + 1))
          fi
          ;;
        *)
          echo "IMAGE OUTSIDE ALLOWLIST: $f (nested below the snapshot directory)"
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

MISSING=0
while IFS= read -r name; do
  [ -n "$name" ] || continue
  if ! is_tracked "${ALLOWED_PREFIX}${name}"; then
    echo "MISSING BASELINE: ${ALLOWED_PREFIX}${name} (a visual test declares it, but git does not track it)"
    MISSING=$((MISSING + 1))
  fi
done < "$EXPECTED"

echo "scripts/check-images.sh: scanned ${SCANNED} tracked image(s), ${VIOLATIONS} outside the allowlist; ${EXPECTED_COUNT} baseline(s) are expected, ${MISSING} missing."

if [ "$SCANNED" -eq 0 ]; then
  echo "scripts/check-images.sh: FAIL: scanned 0 tracked image(s) while ${EXPECTED_COUNT} baseline(s) are expected." >&2
  exit 1
fi
if [ "$VIOLATIONS" -gt 0 ] || [ "$MISSING" -gt 0 ]; then
  exit 1
fi
