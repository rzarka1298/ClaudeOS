#!/bin/sh
# Preflight checks for `pnpm run setup` (REPO-01's single documented
# clean-clone command). Exits non-zero with one actionable sentence on the
# first failure — never lets a downstream tool's cryptic error surface
# first. Checks, in order: Node major version, pnpm major line, Xcode
# Command Line Tools, python3. The last two exist because
# better-sqlite3@13.0.3's published tarball ships C++/C sources and no
# guaranteed prebuilt binary path on every platform — without Xcode CLT
# and python3, a `pnpm install` failure would surface as an opaque
# node-gyp compiler error (research §Pitfall 4).
set -eu

fail() {
  echo "preflight: $1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js was not found on PATH. Install Node 24 LTS (>=24.20.0) before continuing."

NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 24 ]; then
  fail "Node.js major version is $NODE_MAJOR, but this project requires >=24.20.0 (Node 24 LTS). Install Node 24 LTS and re-run."
fi

command -v pnpm >/dev/null 2>&1 || fail "pnpm was not found on PATH. Run: corepack enable && corepack prepare pnpm@11.24.0 --activate"

PNPM_VERSION=$(pnpm --version)
case "$PNPM_VERSION" in
  11.*) ;;
  *) fail "pnpm reports version $PNPM_VERSION, but this project pins the 11.x line. Run: corepack prepare pnpm@11.24.0 --activate" ;;
esac

xcode-select -p >/dev/null 2>&1 || fail "Xcode Command Line Tools were not found. better-sqlite3 compiles from source at install time and needs them. Run: xcode-select --install"

command -v python3 >/dev/null 2>&1 || fail "python3 was not found on PATH. better-sqlite3's node-gyp build step needs it — install Xcode Command Line Tools (xcode-select --install) or Python 3 directly."

echo "preflight: OK (Node ${NODE_MAJOR}, pnpm ${PNPM_VERSION}, Xcode CLT present, python3 present)"
