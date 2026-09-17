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

# Idempotent registration: bootout first, tolerating "not currently
# bootstrapped" (exit code from an absent job), then bootstrap fresh --
# re-running install.sh after the plist changed (a rebuilt SERVICE_MAIN
# path, a different NODE_PATH after an upgrade) actually takes effect
# instead of silently keeping the previous registration alive.
launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "${PLIST_DEST}"

if ! launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
  echo "ERROR: launchctl bootstrap did not register ${LABEL}." >&2
  exit 1
fi

echo "Installed and started ${LABEL}"
echo "  interpreter: ${NODE_PATH}"
echo "  entry point: ${SERVICE_MAIN}"
echo "  runtime dir: ${RUNTIME_DIR}"
echo "  logs:        ${RUNTIME_DIR}/logs/service.{out,err}.log"
