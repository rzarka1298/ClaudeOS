// TEST-ONLY model of an Antigravity window running the codex-bridge extension.
// Never part of the installed kit (KIT_FILES / EXT_FILES do not list it) and never
// started as a process: it drives the same bridge-core.js functions the real
// extension.js calls, against a temporary bridge state directory.
//
// Three modes, so adapter plans can prove their behaviour against each:
//   current   extension 0.2.0: heartbeat with protocol 2 + capabilities, claims
//             follow, tui and agent requests;
//   outdated  extension 0.1.0: heartbeat with ONLY folders and updatedAt, and a scan
//             that deletes any request whose kind or mode it does not know (so an
//             agent request vanishes without a claim, exactly as the installed
//             extension does today);
//   closed    no window: writes no heartbeat and claims nothing.
//
// Plain CommonJS, no dependency, no `vscode` import.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("../antigravity-extension/bridge-core.js");

const MODES = ["current", "outdated", "closed"];
const HEARTBEAT_MS = 30_000; // the real extension's cadence
const DEFAULT_COMMAND = "/simulated/home/.local/bin/codex-bridge";
// What extension 0.1.0 knew. Anything else it deleted with "bad kind" / "bad mode".
const OLD_KINDS = ["review", "task", "resume"];
const OLD_MODES = ["follow", "tui"];

let counter = 0;

/** The real path of the deepest existing ancestor of `p`, with the missing tail re-appended. */
function resolveThroughSymlinks(p) {
  const missing = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...missing.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return cur;
      missing.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** The simulator never touches a directory outside the system temp directory. */
function assertTempStateDir(stateDir) {
  if (typeof stateDir !== "string" || !path.isAbsolute(stateDir))
    throw new Error("window simulator: stateDir must be an absolute path");
  const tmpRoot = fs.realpathSync(os.tmpdir());
  const real = resolveThroughSymlinks(stateDir);
  if (real === tmpRoot || !core.isInside(real, tmpRoot))
    throw new Error("window simulator: stateDir must be inside the system temporary directory");
}

function writeOldShapeHeartbeat(stateDir, key, folders, now) {
  const file = path.join(core.dirs(stateDir).windows, `${key}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${key}.${process.pid}.tmp`);
  fs.writeFileSync(
    tmp,
    `${JSON.stringify({ folders, updatedAt: new Date(now).toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
  fs.renameSync(tmp, file);
}

/**
 * Extension 0.1.0 validated every request and unlinked the invalid ones. Its validator
 * accepted only the old kinds and modes; everything else in a request was validated by
 * code that bridge-core.js still contains unchanged for those kinds, so only the
 * agent-related refusals need reproducing here.
 */
function discardWhatOldExtensionDid(stateDir, log) {
  let names;
  try {
    names = fs.readdirSync(core.dirs(stateDir).requests).sort();
  } catch {
    return;
  }
  for (const name of names) {
    if (!core.REQUEST_FILE_RE.test(name)) continue;
    const file = path.join(core.dirs(stateDir).requests, name);
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {}
    // Unreadable or non-object files are handled (deleted) by the shared scan below.
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const mode = raw.mode === undefined || raw.mode === null ? "follow" : raw.mode;
    const reason = !OLD_KINDS.includes(raw.kind)
      ? "bad kind"
      : !OLD_MODES.includes(mode)
        ? "bad mode"
        : null;
    if (!reason) continue;
    log(`codex-bridge: discarded ${name}: ${reason}`);
    try {
      fs.unlinkSync(file);
    } catch {}
  }
}

/**
 * @param {object} options
 * @param {string} options.stateDir        a directory inside the system temp directory
 * @param {string[]} options.folders       the window's workspace folders
 * @param {"current"|"outdated"|"closed"} options.mode
 * @param {number|(() => number)} [options.now]   fixed time or a clock (default Date.now)
 * @param {string} [options.key]           heartbeat file key (default unique per simulator)
 * @param {string} [options.command]       the fixed launcher path the terminal would run
 * @param {boolean} [options.launcherInstalled]   false leaves requests queued (as the real one)
 * @param {number} [options.containDelayMs]
 */
function createWindowSimulator(options) {
  const {
    stateDir,
    folders,
    mode,
    now,
    key = `sim-${process.pid}-${++counter}`,
    command = DEFAULT_COMMAND,
    launcherInstalled = true,
    containDelayMs = core.CONTAIN_DELAY_MS,
  } = options ?? {};
  if (!MODES.includes(mode)) throw new Error(`window simulator: unknown mode ${String(mode)}`);
  assertTempStateDir(stateDir);
  if (!Array.isArray(folders)) throw new Error("window simulator: folders must be an array");
  if (typeof key !== "string" || !/^[A-Za-z0-9._-]+$/.test(key) || key.startsWith("."))
    throw new Error("window simulator: bad heartbeat key");

  let fixedNow = typeof now === "number" ? now : null;
  const clock = typeof now === "function" ? now : () => fixedNow ?? Date.now();
  const log = [];
  let lastBeat = 0;
  let closed = mode === "closed";

  const beat = () => {
    const at = clock();
    if (closed) return;
    core.ensureDirs(stateDir);
    if (mode === "current") core.writeHeartbeat(stateDir, key, folders, at);
    else writeOldShapeHeartbeat(stateDir, key, folders, at);
    lastBeat = at;
  };

  return {
    mode,
    key,
    log,
    setNow(ms) {
      fixedNow = ms;
    },
    heartbeat: beat,
    /** One poll: heartbeat, scan, claim. Returns what it claimed and the terminal it would open. */
    tick() {
      if (closed) return [];
      const at = clock();
      core.ensureDirs(stateDir);
      if (at - lastBeat >= HEARTBEAT_MS || lastBeat === 0) {
        beat();
        if (mode === "current") core.pruneClaimed(stateDir, at);
      }
      if (!launcherInstalled) return [];
      if (mode === "outdated") discardWhatOldExtensionDid(stateDir, (m) => log.push(m));
      return core
        .scanRequests({
          stateDir,
          folders,
          now: at,
          containDelayMs,
          log: (m) => log.push(m),
        })
        .map((request) => ({ request, terminal: core.terminalOptions(request, command) }));
    },
    /** The window goes away: its heartbeat is removed and it claims nothing further. */
    close() {
      closed = true;
      core.removeHeartbeat(stateDir, key);
    },
  };
}

module.exports = { createWindowSimulator, MODES };
