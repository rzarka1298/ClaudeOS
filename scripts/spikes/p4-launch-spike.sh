#!/bin/sh
# Phase 4 blocking owner spike (plan 04-09 Task 2, PR-04, PR-10).
#
# Runs the service's own launch code -- the script directory, the
# Terminal.app adapter, the git runner and the spawner -- ONCE, as a
# temporary launchd job, and prints its result. It settles, on this Mac:
#   A1  a node-written 0700 .command handed to Terminal opens with no
#       Gatekeeper and no Automation prompt;
#   A11 the cd-failure message stays readable in its window;
#   A2  both scripts deleted themselves;
#   A3, A6  what a launchd-run node gets from lstat, readdir, realpath, git
#       status and a Finder reveal on ~/Documents/ccc-spike-project.
#
# Why launchd: macOS attributes a protected-folder access to the responsible
# process. From this Terminal window node would borrow Terminal's grants;
# as a launchd job it is its own responsible process, exactly like the
# installed service.
#
# Isolation: the job uses a spike-only directory, SPIKE_DIR below (override
# with CCC_P4_SPIKE_DIR only). It never uses the service's runtime
# directory, never touches the installed service, its property list or the
# operational store, and its launchd registration is removed on exit (trap).
# The result file holds enums and booleans only.
#
# SPIKE_DIR must be new, empty, or already carry the spike marker file
# (MARKER_NAME) from an earlier run -- never HOME or a folder containing it
# -- before this script changes its mode or suggests deleting it.
#
# Usage, from the repository root:  sh scripts/spikes/p4-launch-spike.sh
set -eu

LABEL="com.claude-command-center.p4-spike"
SERVICE_DEFAULT_DIR="${HOME}/.claude-command-center"
SPIKE_DIR="${CCC_P4_SPIKE_DIR:-${HOME}/.ccc-p4-spike}"
SPIKE_PROJECT="${HOME}/Documents/ccc-spike-project"
RESULT_NAME="p4-spike-result.json"
MARKER_NAME=".ccc-p4-spike"
PROJECT_MARKER_NAME="ccc-p4-spike-project"
# The same fixed PATH the installed service's LaunchAgent uses.
JOB_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
DOMAIN="gui/$(id -u)"

fail() {
  echo "ERROR: $1" >&2
  exit 1
}

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd -P)
REPO_ROOT=$(cd "${SCRIPT_DIR}/../.." && pwd -P)
HARNESS="${REPO_ROOT}/packages/service/dist/spikes/launch-spike.js"

if [ ! -f "${HARNESS}" ]; then
  echo "The spike harness is not built. From the repository root run:" >&2
  echo "  pnpm exec turbo run build --filter=@ccc/service" >&2
  exit 1
fi

NODE_BIN=$(command -v node || true)
[ -n "${NODE_BIN}" ] || fail "no node on PATH. Install Node.js 24 LTS (24.20.0 or later)."
"${NODE_BIN}" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 24 || (a === 24 && b >= 20) ? 0 : 1)' ||
  fail "node at ${NODE_BIN} is older than 24.20.0."

case "${SPIKE_DIR}" in
  /*) ;;
  *) fail "CCC_P4_SPIKE_DIR must be an absolute path." ;;
esac

# The spike must never share a directory with the installed service.
same_dir() {
  [ "$1" = "$2" ] && return 0
  [ -d "$1" ] && [ -d "$2" ] || return 1
  [ "$(cd "$1" && pwd -P)" = "$(cd "$2" && pwd -P)" ]
}
if same_dir "${SPIKE_DIR}" "${SERVICE_DEFAULT_DIR}"; then
  fail "the spike directory is the service's own runtime directory. Set CCC_P4_SPIKE_DIR to another folder."
fi
if [ -n "${CCC_RUNTIME_DIR+set}" ] && same_dir "${SPIKE_DIR}" "${CCC_RUNTIME_DIR}"; then
  fail "the spike directory equals the exported service runtime directory. Set CCC_P4_SPIKE_DIR to another folder."
fi

# Never HOME, and never a folder that contains HOME: this script changes the
# spike directory's mode and suggests deleting it. Compared physically, so a
# symlinked or dot-dot spelling cannot slip past. A path that does not exist
# yet cannot be HOME or one of its parents.
[ -L "${SPIKE_DIR}" ] && fail "CCC_P4_SPIKE_DIR must not be a symbolic link."
HOME_REAL=$(cd "${HOME}" && pwd -P)
if [ -d "${SPIKE_DIR}" ]; then
  SPIKE_DIR_REAL=$(cd "${SPIKE_DIR}" && pwd -P)
  case "${HOME_REAL}/" in
    "${SPIKE_DIR_REAL%/}/"*)
      fail "CCC_P4_SPIKE_DIR must not be your home folder or a folder that contains it." ;;
  esac
elif [ -e "${SPIKE_DIR}" ]; then
  fail "CCC_P4_SPIKE_DIR exists but is not a folder."
fi

# An existing spike directory must be empty or carry the marker an earlier
# run of this script left, so the chmod below and the removal advice at the
# end can only ever reach a folder this script owns.
if [ -d "${SPIKE_DIR}" ] && [ ! -f "${SPIKE_DIR}/${MARKER_NAME}" ] &&
  [ -n "$(ls -A "${SPIKE_DIR}")" ]; then
  fail "${SPIKE_DIR} is not empty and has no spike marker (${MARKER_NAME}). Set CCC_P4_SPIKE_DIR to a new or empty folder."
fi

# /usr/bin/git is a shim that opens the Command Line Tools installer when no
# developer directory is selected, so git counts as available only when
# xcode-select -p succeeds (the same rule the service uses, D-10).
if ! /usr/bin/xcode-select -p >/dev/null 2>&1; then
  fail "Apple's command line developer tools are not installed (xcode-select -p failed), so git cannot create the synthetic repository. Install them with: xcode-select --install"
fi
command -v git >/dev/null 2>&1 || fail "git is not on PATH, so the synthetic repository cannot be created."

mkdir -p "${SPIKE_DIR}"
: >"${SPIKE_DIR}/${MARKER_NAME}"
chmod 700 "${SPIKE_DIR}"
RESULT_FILE="${SPIKE_DIR}/${RESULT_NAME}"
rm -f "${RESULT_FILE}"

# The synthetic protected-folder project, created only when absent. It is
# built in a staging folder inside SPIKE_DIR and moved into Documents only
# after git init and the first commit succeed, so a failure leaves nothing
# behind in Documents. The commit passes its own identity, so it works with
# no git identity set. A marker inside .git (never a tracked or untracked
# file, so git status stays clean) records that this script created it.
if [ ! -e "${SPIKE_PROJECT}" ]; then
  STAGING="${SPIKE_DIR}/project-staging"
  rm -rf "${STAGING}"
  if mkdir "${STAGING}" &&
    git -C "${STAGING}" init -q &&
    git -C "${STAGING}" -c user.name=spike -c user.email=spike@example.com commit --allow-empty -q -m "spike" &&
    : >"${STAGING}/.git/${PROJECT_MARKER_NAME}" &&
    mv "${STAGING}" "${SPIKE_PROJECT}"; then
    echo "Created the synthetic project folder ${SPIKE_PROJECT}"
  else
    rm -rf "${STAGING}"
    fail "could not create the synthetic git repository at ${SPIKE_PROJECT}; nothing was left in Documents."
  fi
fi
SPIKE_PROJECT_REAL=$(cd "${SPIKE_PROJECT}" && pwd -P)

PLIST_DIR=$(mktemp -d)
PLIST="${PLIST_DIR}/${LABEL}.plist"

cleanup() {
  launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
  rm -rf "${PLIST_DIR}"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Built with plutil, so no value is ever spliced into XML text.
plutil -create xml1 "${PLIST}"
plutil -insert Label -string "${LABEL}" "${PLIST}"
plutil -insert ProgramArguments -array "${PLIST}"
for arg in "${NODE_BIN}" "${HARNESS}" "${SPIKE_DIR}" "${SPIKE_PROJECT_REAL}" "${SPIKE_DIR}"; do
  plutil -insert ProgramArguments -string "${arg}" -append "${PLIST}"
done
plutil -insert RunAtLoad -bool true "${PLIST}"
plutil -insert KeepAlive -bool false "${PLIST}"
plutil -insert EnvironmentVariables -dictionary "${PLIST}"
plutil -insert EnvironmentVariables.PATH -string "${JOB_PATH}" "${PLIST}"
plutil -insert EnvironmentVariables.CCC_RUNTIME_DIR -string "${SPIKE_DIR}" "${PLIST}"
plutil -insert StandardErrorPath -string "${SPIKE_DIR}/spike-stderr.log" "${PLIST}"
plutil -lint "${PLIST}" >/dev/null

# A leftover registration from an interrupted earlier run is removed first.
launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
launchctl bootstrap "${DOMAIN}" "${PLIST}"

echo "The spike is running as a temporary launchd job. Two Terminal windows and one Finder window will open."
waited=0
while [ ! -f "${RESULT_FILE}" ] && [ "${waited}" -lt 40 ]; do
  sleep 1
  waited=$((waited + 1))
done

if [ ! -f "${RESULT_FILE}" ]; then
  fail "no result after 40 seconds. Details, if any, are in ${SPIKE_DIR}/spike-stderr.log"
fi

echo
echo "Spike result:"
cat "${RESULT_FILE}"
echo
# Removal is only ever suggested for folders carrying this script's markers.
echo "When the end-of-phase UAT is done, remove the spike folders with:"
if [ -f "${SPIKE_PROJECT}/.git/${PROJECT_MARKER_NAME}" ]; then
  echo "  rm -rf \"${SPIKE_PROJECT}\" \"${SPIKE_DIR}\""
else
  echo "  rm -rf \"${SPIKE_DIR}\""
  echo "(${SPIKE_PROJECT} was not created by this script, so it is left to you.)"
fi
