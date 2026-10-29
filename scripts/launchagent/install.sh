#!/bin/sh
# Registers the companion service as a per-user launchd LaunchAgent
# (ADR-0015, ADR-01, SVC-05). Resolves an absolute Node interpreter and an
# absolute service entry point in THIS shell's own context, substitutes
# them into the property-list template (launchd inherits none of this
# shell's PATH or environment at run time), and registers with
# `launchctl bootstrap` -- never `load`/`unload`, which have been
# deprecated since OS X 10.10 and exit zero while doing nothing on an
# already-bootstrapped or malformed property list, making a failed
# install indistinguishable from a successful one.
set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "${SCRIPT_DIR}/../.." && pwd)
LABEL="com.claude-command-center.service"
PLIST_TEMPLATE="${SCRIPT_DIR}/${LABEL}.plist.template"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
PLIST_DEST="${LAUNCH_AGENTS_DIR}/${LABEL}.plist"
RUNTIME_DIR="${CCC_RUNTIME_DIR:-${HOME}/.claude-command-center}"
SERVICE_MAIN="${REPO_ROOT}/packages/service/dist/main.js"

NODE_PATH=$(command -v node || true)
if [ -z "${NODE_PATH}" ]; then
  echo "ERROR: no 'node' found on PATH. Install Node.js 24 LTS (>=24.20.0) before running this script." >&2
  exit 1
fi

NODE_MAJOR=$("${NODE_PATH}" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
if [ "${NODE_MAJOR}" -lt 24 ]; then
  echo "ERROR: node at ${NODE_PATH} is major version ${NODE_MAJOR}; this service requires Node >=24.20.0." >&2
  exit 1
fi

if [ ! -f "${SERVICE_MAIN}" ]; then
  echo "ERROR: ${SERVICE_MAIN} does not exist. Run 'pnpm run build' first." >&2
  exit 1
fi

mkdir -p "${LAUNCH_AGENTS_DIR}"
mkdir -p "${RUNTIME_DIR}/logs"

sed \
  -e "s#__NODE_PATH__#${NODE_PATH}#g" \
  -e "s#__SERVICE_MAIN__#${SERVICE_MAIN}#g" \
  -e "s#__RUNTIME_DIR__#${RUNTIME_DIR}#g" \
  "${PLIST_TEMPLATE}" > "${PLIST_DEST}"

# The owner-presence helper (APPR-11, D-01, R-01, R-02; 09-PRESENCE-SPIKE.md: custody K-ATTR).
# Build it from source with the Command Line Tools clang and enrol its signing key. An
# ad-hoc signature changes on every rebuild and the key's Keychain item trusts only the
# binary that created it, so an earlier helper (still the old binary at this point)
# unenrols FIRST, then the new binary enrols. A failed build or enrolment is a WARNING,
# never an install failure: the service starts and connector-class approvals are refused
# until the helper works (Diagnostics shows its state). No test or sandbox reaches here
# with a real helper: the install test points HOME and CCC_RUNTIME_DIR at temp directories.
#
# FIX6B: unenrol, and the replacement of an existing key by enrol, now ask for Touch ID or the
# password (the helper no longer deletes its key for any caller), so an install that replaces a
# helper shows ONE prompt. Each helper call is bounded (default 90 s; the helper's own prompt
# ceiling is 60 s) and its JSON answer is kept in the WARNING. If the old helper cannot remove its
# key, the old binary is KEPT: rebuilding over it would leave a key that no installed binary is
# trusted to read, so the helper is not replaced this time and the service install goes on.
PRESENCE_BUILD="${REPO_ROOT}/scripts/presence/build.sh"
PRESENCE_RUN="${SCRIPT_DIR}/../presence/run-helper.mjs"
PRESENCE_HELPER="${RUNTIME_DIR}/bin/ccc-presence"
PRESENCE_TIMEOUT="${CCC_PRESENCE_HELPER_TIMEOUT:-90}"
PRESENCE_WARNING="WARNING: the presence helper was not built; connector-class approvals will be refused until it is (Diagnostics shows it)."

# Runs one helper subcommand under the bound, leaving its exit code in helper_rc and its output (the
# helper's JSON line, or the bound's "timed out" line) in helper_out. Never trips `set -e`.
run_helper() {
  if helper_out=$("${NODE_PATH}" "${PRESENCE_RUN}" "${PRESENCE_TIMEOUT}" "${PRESENCE_HELPER}" "$1" 2>&1); then
    helper_rc=0
  else
    helper_rc=$?
  fi
}

REPLACE_PRESENCE=1
if [ -x "${PRESENCE_HELPER}" ]; then
  run_helper unenrol
  if [ "${helper_rc}" -ne 0 ]; then
    REPLACE_PRESENCE=0
    echo "WARNING: the previous presence helper could not remove its previous signing key (${helper_out}); the existing helper and key were kept and the helper was not replaced this time. Run the install again and answer the Touch ID or password prompt to replace it." >&2
  fi
fi
if [ "${REPLACE_PRESENCE}" -eq 1 ]; then
  if [ -f "${PRESENCE_BUILD}" ]; then
    if ! CCC_RUNTIME_DIR="${RUNTIME_DIR}" sh "${PRESENCE_BUILD}"; then
      echo "${PRESENCE_WARNING}" >&2
    fi
  else
    echo "${PRESENCE_WARNING}" >&2
  fi
  if [ -x "${PRESENCE_HELPER}" ]; then
    run_helper enrol
    if [ "${helper_rc}" -ne 0 ]; then
      echo "WARNING: the presence helper could not enrol its signing key (${helper_out}); connector-class approvals will be refused until it does (Diagnostics shows it)." >&2
    else
      # 09-18: the install is the one legitimate writer of the pin. Leave a marker the service consumes as it
      # starts (it reads the pin once at boot, 09-FIX9), so a pin that differs from the one it recorded is adopted
      # ONCE for this install and refused (presence-pin-changed) at any other time. The service honours a marker
      # only if it is a plain file written within the last ten minutes. The marker holds nothing.
      : > "${RUNTIME_DIR}/presence-pin-installed"
    fi
  fi
fi

# Idempotent registration: bootout first, tolerating "not currently
# bootstrapped" (exit code from an absent job), then bootstrap fresh --
# re-running install.sh after the plist changed (a rebuilt SERVICE_MAIN
# path, a different NODE_PATH after an upgrade) actually takes effect
# instead of silently keeping the previous registration alive.
#
# `bootout` returns before launchd has finished unloading the old job, so an
# immediate `bootstrap` can fail with "Bootstrap failed: 5: Input/output
# error" (the 08-UAT sitting saw this twice in a row). Poll `launchctl print`
# until the label is gone before bootstrapping (D-10, SVC-12). The first poll
# runs before any sleep, so a first install (nothing registered) waits zero
# times. The knobs exist so a test can lower them; production keeps the
# defaults (100 polls at 0.1 s, about 10 s).
POLL_INTERVAL="${CCC_INSTALL_POLL_INTERVAL:-0.1}"
POLL_LIMIT="${CCC_INSTALL_POLL_LIMIT:-100}"

wait_until_gone() {
  polls=0
  while launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; do
    polls=$((polls + 1))
    if [ "${polls}" -ge "${POLL_LIMIT}" ]; then
      echo "ERROR: ${LABEL} is still registered after waiting; run 'launchctl bootout gui/$(id -u)/${LABEL}' and try again." >&2
      exit 1
    fi
    sleep "${POLL_INTERVAL}"
  done
}

RETRY_DELAY="${CCC_INSTALL_RETRY_DELAY:-1}"

# Runs `bootstrap` without tripping `set -e`, leaving the exit code in
# bootstrap_rc and the combined output in bootstrap_out.
bootstrap_once() {
  if bootstrap_out=$(launchctl bootstrap "gui/$(id -u)" "${PLIST_DEST}" 2>&1); then
    bootstrap_rc=0
  else
    bootstrap_rc=$?
  fi
}

launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
wait_until_gone
bootstrap_once
if [ "${bootstrap_rc}" -eq 5 ]; then
  # Error 5 is the transient "Input/output error" launchd gives while the old
  # job is still tearing down: wait again and retry exactly once.
  sleep "${RETRY_DELAY}"
  wait_until_gone
  bootstrap_once
  if [ "${bootstrap_rc}" -ne 0 ]; then
    echo "ERROR: launchctl bootstrap failed twice:" >&2
    echo "${bootstrap_out}" >&2
    exit "${bootstrap_rc}"
  fi
elif [ "${bootstrap_rc}" -ne 0 ]; then
  echo "ERROR: launchctl bootstrap failed (exit ${bootstrap_rc}):" >&2
  echo "${bootstrap_out}" >&2
  exit "${bootstrap_rc}"
fi

if ! launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
  echo "ERROR: launchctl bootstrap did not register ${LABEL}." >&2
  exit 1
fi

echo "Installed and started ${LABEL}"
echo "  interpreter: ${NODE_PATH}"
echo "  entry point: ${SERVICE_MAIN}"
echo "  runtime dir: ${RUNTIME_DIR}"
echo "  logs:        ${RUNTIME_DIR}/logs/service.{out,err}.log"
