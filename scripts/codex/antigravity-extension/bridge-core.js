// codex-bridge core: the request protocol between the Codex wrapper
// (scripts/codex/codex.mjs) and the Antigravity IDE extension (extension.js).
//
// Plain CommonJS with no dependencies and no `vscode` import, so it is shared
// verbatim by the wrapper (via createRequire), the extension, and the tests.
//
// Protocol (all under the bridge state dir, user-level):
//   requests/<runId>.json   written atomically by the wrapper when a run starts
//   claimed/<runId>.json    a window claimed it (atomic rename: exactly one wins)
//   windows/<key>.json      heartbeat per IDE window: its workspace folders
//
// Nothing in a request is ever executed or interpolated into a shell. The
// terminal runs the fixed `codex-bridge` launcher with argv ["follow" | "tui" | "agent", runId],
// where runId has been checked against a strict digits-only pattern. An agent request
// (protocol 2) carries a validated argv and CCC_ environment, but only the helper reads them,
// after re-validating with validateAgentShape; no request field reaches a shell or a URI.

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const RUN_ID_RE = /^[0-9]{8}T[0-9]{9}Z$/;
const REQUEST_FILE_RE = /^[0-9]{8}T[0-9]{9}Z\.json$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ["review", "task", "resume", "agent"];
// follow = tail a headless run's live log; tui = run the interactive Codex TUI as the worker;
// agent = run `claude` or `codex` directly in a tab (protocol 2, validated argv, no shell).
const MODES = ["follow", "tui", "agent"];
const ROLES = ["review", "plan", "task", "chore"];
const TTL_MS = 10 * 60 * 1000;
const FUTURE_SKEW_MS = 60 * 1000;
const HEARTBEAT_FRESH_MS = 90 * 1000;
const CONTAIN_DELAY_MS = 2000;
const CLAIMED_KEEP_MS = 24 * 60 * 60 * 1000;

// Protocol 2 (agent mode). A heartbeat without `protocol` comes from an extension that
// predates agent mode (0.1.0); the product reports that as "bridge outdated".
const PROTOCOL_VERSION = 2;
const CAPABILITIES = ["follow", "tui", "agent"];
const AGENTS = ["claude", "codex"];
const AGENT_ARGV_MAX = 32;
const AGENT_ELEMENT_MAX = 4096;
const AGENT_ENV_MAX = 16;
const AGENT_ENV_VALUE_MAX = 1024;
const AGENT_ENV_KEY_RE = /^CCC_[A-Z0-9_]+$/;
// Compared after NFKC, lower-casing and removal of every non-alphanumeric: the Phase 4 pair
// (@ccc/launchers FORBIDDEN_PERMISSION_TOKENS) plus the wrapper's own BANNED set, normalised.
const BANNED_TOKENS = [
  "dangerouslyskippermissions",
  "bypasspermissions",
  "dangerouslybypassapprovalsandsandbox",
  "dangerouslybypasshooktrust",
  "yolo",
  "fullauto",
  "approveforme",
  "dangerfullaccess",
];
// The fixed reason vocabulary of validateAgentShape.
const AGENT_REASONS = [
  "bad-agent",
  "bad-argv",
  "argv-length",
  "argv-element",
  "argv-control",
  "argv0-not-absolute",
  "argv0-basename",
  "banned-flag",
  "bad-env",
  "env-key",
  "env-value",
];

/** The user-level bridge state dir: $XDG_STATE_HOME/codex-bridge or ~/.local/state/codex-bridge. */
function bridgeStateDir(env = process.env, home = os.homedir()) {
  const xdg = env.XDG_STATE_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".local", "state");
  return path.join(base, "codex-bridge");
}

/** The fixed helper every bridge terminal runs. */
function bridgeCommand(home = os.homedir()) {
  return path.join(home, ".local", "bin", "codex-bridge");
}

function dirs(stateDir) {
  return {
    requests: path.join(stateDir, "requests"),
    claimed: path.join(stateDir, "claimed"),
    windows: path.join(stateDir, "windows"),
    prompts: path.join(stateDir, "prompts"),
    tui: path.join(stateDir, "tui"),
  };
}

function ensureDirs(stateDir) {
  for (const d of Object.values(dirs(stateDir))) fs.mkdirSync(d, { recursive: true });
}

function realDir(p) {
  if (typeof p !== "string" || !path.isAbsolute(p)) return null;
  try {
    const r = fs.realpathSync(p);
    return fs.statSync(r).isDirectory() ? r : null;
  } catch {
    return null;
  }
}

function realFile(p) {
  if (typeof p !== "string" || !path.isAbsolute(p)) return null;
  try {
    const r = fs.realpathSync(p);
    return fs.statSync(r).isFile() ? r : null;
  } catch {
    return null;
  }
}

function isInside(child, parent) {
  return (
    child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)
  );
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// C0 (including TAB), DEL, C1, U+2028 and U+2029.
// biome-ignore lint/suspicious/noControlCharactersInRegex: this IS the control-character refusal.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function normaliseForBanMatch(element) {
  return element
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// Deny-by-default flag rules for the FINAL argv (review F-01/F-02). The ban-token match above
// compares text; these rules compare what the real CLI parsers will decide. Config-carrying
// flags are refused outright because their values are TOML (`-c`) or JSON (`--settings`) that
// the CLI decodes (`\u002d` escapes) after the text check would have passed.
const DENIED_LONG_FLAGS = [
  "--config",
  "--profile",
  "--settings",
  "--mcp-config",
  "--plugin-dir",
  "--agents",
  "--allowedtools",
  "--allowed-tools",
];
const DENIED_CODEX_SHORT = ["c", "p"]; // -c key=value overrides, -p profile (claude's -c is --continue)
// Subcommands are ALLOWLISTED, never denylisted (review: the CLIs have aliases such as codex
// `e` = exec and `a` = apply). The product launches `claude` with no subcommand and `codex`
// with no subcommand or `resume <uuid>`; every other bare operand (a subcommand, an alias or a
// positional prompt, which would be dispatched as a subcommand if it matched one) is refused.
const ALLOWED_SUBCOMMANDS = { claude: [], codex: ["resume"] };
// Flags known to take one value (the value is not an operand). --add-dir is variadic for claude.
const VALUE_FLAGS = {
  claude: [
    "--model",
    "--permission-mode",
    "--resume",
    "-r",
    "--session-id",
    "--append-system-prompt",
    "--add-dir",
  ],
  codex: [
    "--model",
    "-m",
    "--cd",
    "-C",
    "--add-dir",
    "--ask-for-approval",
    "-a",
    "--sandbox",
    "-s",
  ],
};
const PERMISSION_MODES = ["default", "plan", "acceptEdits"];
const CODEX_APPROVALS = ["untrusted", "on-failure", "on-request"];
const CODEX_SANDBOXES = ["read-only", "workspace-write"];
// Flags whose value is a directory: containment is checked against the project root by
// validateAgentRequest (needs the filesystem). claude's --add-dir is variadic.
const DIR_FLAGS = {
  claude: { long: ["--add-dir"], short: [], variadic: ["--add-dir"] },
  codex: { long: ["--cd", "--add-dir"], short: ["C"], variadic: [] },
};

/**
 * Splits one argv element into { flag, inline } where flag is the normalised flag name
 * ("--long" lower-cased with _ as -, or "-x") and inline the attached value (--flag=value,
 * -xvalue) or undefined. Not a flag: null.
 */
function parseFlag(element) {
  if (element.startsWith("--")) {
    if (element === "--") return null;
    const eq = element.indexOf("=");
    const name = (eq === -1 ? element : element.slice(0, eq)).toLowerCase().replace(/_/g, "-");
    return { flag: name, inline: eq === -1 ? undefined : element.slice(eq + 1) };
  }
  if (/^-[A-Za-z]/.test(element)) {
    const rest = element.slice(2);
    return { flag: element.slice(0, 2), inline: rest === "" ? undefined : rest.replace(/^=/, "") };
  }
  return null;
}

/** The reason an argv[1..] breaks the flag rules, or null. */
function flagRuleViolation(agent, argv) {
  const valueFlags = VALUE_FLAGS[agent];
  const variadic = DIR_FLAGS[agent].variadic;
  let consumedUpTo = 0; // argv indexes <= this are values of an earlier flag, not operands
  let operands = 0;
  for (let i = 1; i < argv.length; i++) {
    const element = argv[i];
    const parsed = parseFlag(element);
    if (!parsed) {
      if (i <= consumedUpTo) continue;
      // A bare operand (or `--`): only codex's `resume` as the first operand is allowed.
      if (element === "--" || operands > 0 || !ALLOWED_SUBCOMMANDS[agent].includes(element))
        return "banned-flag";
      operands++;
      consumedUpTo = i + 1; // the session id, validated below
      continue;
    }
    const { flag, inline } = parsed;
    if (inline === undefined && valueFlags.includes(flag)) {
      consumedUpTo = i + 1;
      if (variadic.includes(flag))
        while (consumedUpTo + 1 < argv.length && !argv[consumedUpTo + 1].startsWith("-"))
          consumedUpTo++;
    }
    const value = inline !== undefined ? inline : argv[i + 1];
    if (DENIED_LONG_FLAGS.includes(flag)) return "banned-flag";
    if (agent === "codex" && flag.length === 2 && DENIED_CODEX_SHORT.includes(flag[1]))
      return "banned-flag";
    if (flag === "--permission-mode" && !PERMISSION_MODES.includes(value)) return "banned-flag";
    if (agent === "codex") {
      if ((flag === "-a" || flag === "--ask-for-approval") && !CODEX_APPROVALS.includes(value))
        return "banned-flag";
      if ((flag === "-s" || flag === "--sandbox") && !CODEX_SANDBOXES.includes(value))
        return "banned-flag";
    }
    if (agent === "claude" && ["--resume", "-r", "--session-id"].includes(flag)) {
      if (typeof value !== "string" || !UUID_RE.test(value)) return "bad-argv";
    }
  }
  if (agent === "codex") {
    const at = argv.indexOf("resume", 1);
    if (at !== -1 && !(typeof argv[at + 1] === "string" && UUID_RE.test(argv[at + 1])))
      return "bad-argv";
  }
  return null;
}

/**
 * Every directory argument of argv as { flag, value }: flag is the normalised flag name and
 * value the raw string (the caller resolves it); null = the flag has no value.
 */
function directoryEntries(agent, argv) {
  const rules = DIR_FLAGS[agent];
  const found = [];
  for (let i = 1; i < argv.length; i++) {
    const parsed = parseFlag(argv[i]);
    if (!parsed) continue;
    const { flag, inline } = parsed;
    const isDir = rules.long.includes(flag) || (flag.length === 2 && rules.short.includes(flag[1]));
    if (!isDir) continue;
    if (inline !== undefined) {
      found.push({ flag, value: inline });
      continue;
    }
    const values = [];
    for (
      let j = i + 1;
      j < argv.length && (values.length === 0 || rules.variadic.includes(flag));
      j++
    ) {
      if (argv[j].startsWith("-")) break;
      values.push(argv[j]);
    }
    if (values.length === 0) found.push({ flag, value: null });
    else for (const value of values) found.push({ flag, value });
  }
  return found;
}

/** True for the codex working-directory flags (--cd, -C): the base every other path resolves against. */
function isWorkingDirFlag(agent, flag) {
  return agent === "codex" && (flag === "--cd" || flag === "-C");
}

/**
 * The pure shape rules for an agent request's { agent, argv, env }. No filesystem
 * access; the reason is one of AGENT_REASONS. This is the function the hostile corpus
 * (scripts/codex/hostile-corpus.json) is run through, here and, in plan 05.1-09, in
 * the TypeScript validator. Check order (reasons are order-sensitive for a case with
 * more than one defect): agent, argv shape, per element (type/size, then control
 * characters), argv[0] absolute, argv[0] basename, ban tokens, env.
 */
function validateAgentShape(input) {
  const no = (reason) => ({ ok: false, reason });
  if (!input || typeof input !== "object") return no("bad-agent");
  const { agent, argv, env } = input;
  if (typeof agent !== "string" || !AGENTS.includes(agent)) return no("bad-agent");
  if (!Array.isArray(argv)) return no("bad-argv");
  if (argv.length < 1 || argv.length > AGENT_ARGV_MAX) return no("argv-length");
  for (const element of argv) {
    if (typeof element !== "string" || element.length < 1 || element.length > AGENT_ELEMENT_MAX)
      return no("argv-element");
    if (CONTROL_RE.test(element)) return no("argv-control");
  }
  const exe = argv[0];
  if (!exe.startsWith("/")) return no("argv0-not-absolute");
  const segments = exe.split("/").slice(1);
  if (segments.some((seg) => seg === "" || seg === "." || seg === ".."))
    return no("argv0-not-absolute");
  if (segments[segments.length - 1] !== agent) return no("argv0-basename");
  for (const element of argv) {
    const normalised = normaliseForBanMatch(element);
    if (BANNED_TOKENS.some((token) => normalised.includes(token))) return no("banned-flag");
  }
  const violation = flagRuleViolation(agent, argv);
  if (violation) return no(violation);
  if (
    !env ||
    typeof env !== "object" ||
    Array.isArray(env) ||
    (Object.getPrototypeOf(env) !== Object.prototype && Object.getPrototypeOf(env) !== null)
  )
    return no("bad-env");
  const keys = Object.keys(env);
  if (keys.length > AGENT_ENV_MAX) return no("bad-env");
  for (const key of keys) if (!AGENT_ENV_KEY_RE.test(key)) return no("env-key");
  for (const key of keys) {
    const value = env[key];
    if (typeof value !== "string" || value.length > AGENT_ENV_VALUE_MAX || CONTROL_RE.test(value))
      return no("env-value");
  }
  return { ok: true };
}

// The only top-level keys an agent request may carry; the product generates exactly these.
const AGENT_REQUEST_KEYS = [
  "runId",
  "kind",
  "mode",
  "agent",
  "projectRoot",
  "cwd",
  "argv",
  "env",
  "sessionId",
  "liveLog",
  "pid",
  "createdAt",
  "protocol",
];

/** The agent branch of validateRequest: fixed shape, protocol 2, no log, session or pid. */
function validateAgentRequest(raw, { now, ttlMs, checkAge }) {
  const no = (reason, expired = false) => ({ ok: false, reason, expired });
  for (const key of Object.keys(raw)) {
    if (!AGENT_REQUEST_KEYS.includes(key)) return no("agent request has an unknown key");
  }
  if (raw.kind !== "agent" || raw.mode !== "agent") return no("kind and mode must both be agent");
  if (raw.protocol !== PROTOCOL_VERSION) return no("agent request needs protocol 2");
  for (const key of ["sessionId", "liveLog", "pid"]) {
    if (raw[key] !== undefined && raw[key] !== null) return no(`agent request has a ${key}`);
  }
  const projectRoot = realDir(raw.projectRoot);
  if (!projectRoot) return no("projectRoot is not an absolute existing directory");
  const cwd = raw.cwd === undefined || raw.cwd === null ? projectRoot : realDir(raw.cwd);
  if (!cwd) return no("cwd is not an absolute existing directory");
  if (!isInside(cwd, projectRoot)) return no("cwd is outside the project root");
  const shape = validateAgentShape({ agent: raw.agent, argv: raw.argv, env: raw.env });
  if (!shape.ok) return no(`agent shape: ${shape.reason}`);
  // Codex resolves --add-dir (and every other path) against its --cd/-C directory, so that
  // effective directory is computed first (relative to the request cwd; the last --cd wins,
  // as in the CLI) and everything else is realpath-checked against it.
  const entries = directoryEntries(raw.agent, raw.argv);
  let effectiveCwd = cwd;
  for (const entry of entries) {
    if (!isWorkingDirFlag(raw.agent, entry.flag)) continue;
    const resolved = entry.value === null ? null : realDir(path.resolve(cwd, entry.value));
    if (!resolved || !isInside(resolved, projectRoot))
      return no("a directory argument is missing or outside the project root");
    effectiveCwd = resolved;
  }
  for (const entry of entries) {
    if (isWorkingDirFlag(raw.agent, entry.flag)) continue;
    const resolved = entry.value === null ? null : realDir(path.resolve(effectiveCwd, entry.value));
    if (!resolved || !isInside(resolved, projectRoot))
      return no("a directory argument is missing or outside the project root");
  }
  if (!isExecutable(raw.argv[0])) return no("argv[0] is not an executable file");
  const created = typeof raw.createdAt === "string" ? Date.parse(raw.createdAt) : Number.NaN;
  if (!Number.isFinite(created)) return no("bad createdAt");
  if (checkAge) {
    if (now - created > ttlMs) return no("expired", true);
    if (created - now > FUTURE_SKEW_MS) return no("createdAt is in the future");
  }
  return {
    ok: true,
    request: {
      runId: raw.runId,
      kind: "agent",
      mode: "agent",
      agent: raw.agent,
      projectRoot,
      cwd,
      argv: [...raw.argv],
      env: { ...raw.env },
      sessionId: null,
      liveLog: null,
      pid: null,
      createdAt: raw.createdAt,
      protocol: PROTOCOL_VERSION,
      role: null,
      promptFile: null,
      codexHome: null,
    },
  };
}

/**
 * Validates a request strictly. Returns { ok: true, request } with real paths,
 * or { ok: false, reason, expired }.
 */
function validateRequest(raw, { stateDir, now = Date.now(), ttlMs = TTL_MS, checkAge = true }) {
  const no = (reason, expired = false) => ({ ok: false, reason, expired });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return no("not an object");
  if (typeof raw.runId !== "string" || !RUN_ID_RE.test(raw.runId)) return no("bad runId");
  if (!KINDS.includes(raw.kind)) return no("bad kind");
  // Agent mode is a separate, fixed-shape branch; follow and tui validation below is unchanged.
  if (raw.kind === "agent" || raw.mode === "agent")
    return validateAgentRequest(raw, { now, ttlMs, checkAge });
  const projectRoot = realDir(raw.projectRoot);
  if (!projectRoot) return no("projectRoot is not an absolute existing directory");
  const cwd = raw.cwd === undefined || raw.cwd === null ? projectRoot : realDir(raw.cwd);
  if (!cwd) return no("cwd is not an absolute existing directory");
  if (raw.sessionId !== null && (typeof raw.sessionId !== "string" || !UUID_RE.test(raw.sessionId)))
    return no("sessionId is not a UUID");
  if (typeof raw.liveLog !== "string" || !raw.liveLog.endsWith(".log")) return no("bad liveLog");
  const liveLog = realFile(raw.liveLog);
  if (!liveLog) return no("liveLog is not an absolute existing file");
  const roots = [realDir(stateDir), realDir(path.join(projectRoot, ".planning", "codex", "live"))];
  if (!roots.some((r) => r && isInside(liveLog, r)))
    return no("liveLog is outside the bridge state dir and the project's codex live dir");
  if (raw.pid !== undefined && raw.pid !== null && !(Number.isInteger(raw.pid) && raw.pid > 0))
    return no("bad pid");
  const mode = raw.mode === undefined || raw.mode === null ? "follow" : raw.mode;
  if (!MODES.includes(mode)) return no("bad mode");
  let role = null;
  let promptFile = null;
  if (mode === "tui") {
    if (!ROLES.includes(raw.role)) return no("tui needs a known role");
    promptFile = realFile(raw.promptFile);
    const prompts = realDir(dirs(stateDir).prompts);
    if (!promptFile || !prompts || path.dirname(promptFile) !== prompts)
      return no("tui promptFile must be a file directly in the bridge prompts dir");
    if (path.basename(promptFile) !== `${raw.runId}.md`) return no("tui promptFile name");
    role = raw.role;
  }
  let codexHome = null;
  if (raw.codexHome !== undefined && raw.codexHome !== null) {
    codexHome = realDir(raw.codexHome);
    if (!codexHome) return no("codexHome is not an absolute existing directory");
  }
  const created = typeof raw.createdAt === "string" ? Date.parse(raw.createdAt) : Number.NaN;
  if (!Number.isFinite(created)) return no("bad createdAt");
  if (checkAge) {
    if (now - created > ttlMs) return no("expired", true);
    if (created - now > FUTURE_SKEW_MS) return no("createdAt is in the future");
  }
  return {
    ok: true,
    request: {
      runId: raw.runId,
      kind: raw.kind,
      projectRoot,
      cwd,
      sessionId: raw.sessionId,
      liveLog,
      pid: raw.pid ?? null,
      createdAt: raw.createdAt,
      mode,
      role,
      promptFile,
      codexHome,
    },
  };
}

/** 2 = a folder is the project root, 1 = a folder contains it, 0 = no match. */
function matchScore(folders, projectRoot) {
  const root = realDir(projectRoot);
  if (!root) return 0;
  let best = 0;
  for (const f of folders ?? []) {
    const r = realDir(f);
    if (!r) continue;
    if (r === root) return 2;
    if (isInside(root, r)) best = 1;
  }
  return best;
}

/** Atomic claim: the rename succeeds for exactly one window. */
function claim(stateDir, name) {
  const d = dirs(stateDir);
  fs.mkdirSync(d.claimed, { recursive: true });
  const to = path.join(d.claimed, name);
  try {
    fs.renameSync(path.join(d.requests, name), to);
    return to;
  } catch {
    return null;
  }
}

/**
 * One scan of the request queue on behalf of a window with `folders` open.
 * Discards expired or invalid requests, leaves other projects' requests alone,
 * and returns the requests this window claimed. A window that only CONTAINS the
 * project waits `containDelayMs` so a window opened exactly on it wins.
 */
function scanRequests({
  stateDir,
  folders,
  now = Date.now(),
  ttlMs = TTL_MS,
  containDelayMs = CONTAIN_DELAY_MS,
  log = () => {},
}) {
  const d = dirs(stateDir);
  let names;
  try {
    names = fs.readdirSync(d.requests).sort();
  } catch {
    return [];
  }
  const claimed = [];
  for (const name of names) {
    if (!REQUEST_FILE_RE.test(name)) continue; // temp files start with "."
    const file = path.join(d.requests, name);
    const raw = readJson(file);
    const v = raw
      ? validateRequest(raw, { stateDir, now, ttlMs })
      : { ok: false, reason: "unreadable" };
    if (v.ok && `${v.request.runId}.json` !== name) Object.assign(v, { ok: false, reason: "name" });
    if (!v.ok) {
      log(`codex-bridge: discarded ${name}: ${v.reason}`);
      try {
        fs.unlinkSync(file);
      } catch {}
      continue;
    }
    const score = matchScore(folders, v.request.projectRoot);
    if (score === 0) continue;
    if (score === 1 && now - Date.parse(v.request.createdAt) < containDelayMs) continue;
    if (claim(stateDir, name)) claimed.push(v.request);
  }
  return claimed;
}

/** Re-reads and re-validates a claimed request for `codex-bridge follow`. */
function readClaimed(stateDir, runId) {
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId))
    return { ok: false, reason: "bad runId" };
  const raw = readJson(path.join(dirs(stateDir).claimed, `${runId}.json`));
  if (!raw) return { ok: false, reason: "no claimed request" };
  const v = validateRequest(raw, { stateDir, checkAge: false });
  if (v.ok && v.request.runId !== runId) return { ok: false, reason: "runId mismatch" };
  return v;
}

const AGENT_TAB_NAMES = { claude: "Claude Code", codex: "Codex" };

/** The terminal a claimed request opens: fixed helper, argv only, no shell. */
function terminalOptions(request, command) {
  if (request.mode === "agent") {
    // Nothing from the request reaches the terminal but the run id: the helper re-reads the
    // claimed request and re-validates it before it starts anything.
    return {
      name: AGENT_TAB_NAMES[request.agent] ?? "Agent",
      shellPath: command,
      shellArgs: ["agent", request.runId],
      cwd: request.cwd,
      isTransient: true,
    };
  }
  return {
    name: `Codex · ${request.kind} · ${request.runId.slice(9, 15)}`,
    shellPath: command,
    shellArgs: [request.mode === "tui" ? "tui" : "follow", request.runId],
    cwd: request.cwd,
    isTransient: true,
  };
}

function writeRequest(stateDir, request) {
  const file = path.join(dirs(stateDir).requests, `${request.runId}.json`);
  if (fs.existsSync(file)) return null;
  writeJsonAtomic(file, request);
  return file;
}

/**
 * One heartbeat per IDE window. `protocol` and `capabilities` advertise what this extension
 * can claim: a heartbeat WITHOUT `protocol` comes from an extension that predates agent mode
 * (0.1.0), which deletes any request mode it does not know. Readers treat that as "outdated".
 */
function writeHeartbeat(stateDir, key, folders, now = Date.now()) {
  writeJsonAtomic(path.join(dirs(stateDir).windows, `${key}.json`), {
    folders,
    updatedAt: new Date(now).toISOString(),
    protocol: PROTOCOL_VERSION,
    capabilities: [...CAPABILITIES],
  });
}

function removeHeartbeat(stateDir, key) {
  try {
    fs.unlinkSync(path.join(dirs(stateDir).windows, `${key}.json`));
  } catch {}
}

/**
 * Every fresh heartbeat whose window has the project open, in file-name order. `protocol` and
 * `capabilities` are null for a heartbeat of the old shape (folders and updatedAt only).
 */
function coveringHeartbeats(stateDir, projectRoot, now = Date.now()) {
  let names;
  try {
    names = fs.readdirSync(dirs(stateDir).windows).sort();
  } catch {
    return [];
  }
  const found = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const hb = readJson(path.join(dirs(stateDir).windows, name));
    const at = hb && typeof hb.updatedAt === "string" ? Date.parse(hb.updatedAt) : Number.NaN;
    if (!Number.isFinite(at) || now - at > HEARTBEAT_FRESH_MS) continue;
    if (!Array.isArray(hb.folders) || matchScore(hb.folders, projectRoot) === 0) continue;
    found.push({
      folders: hb.folders,
      updatedAt: hb.updatedAt,
      protocol: Number.isInteger(hb.protocol) ? hb.protocol : null,
      capabilities:
        Array.isArray(hb.capabilities) && hb.capabilities.every((c) => typeof c === "string")
          ? hb.capabilities
          : null,
    });
  }
  return found;
}

/** The first fresh heartbeat covering the project, or null. */
function coveringHeartbeat(stateDir, projectRoot, now = Date.now()) {
  return coveringHeartbeats(stateDir, projectRoot, now)[0] ?? null;
}

/** True when a live IDE window (fresh heartbeat) has the project open. */
function windowCovers(stateDir, projectRoot, now = Date.now()) {
  return coveringHeartbeat(stateDir, projectRoot, now) !== null;
}

const PROTOCOL_MARKER_FILE = "protocol.json";

/**
 * install-user-kit writes this beside the bridge state: it tells the product what the
 * installed kit speaks before any IDE window (and so any heartbeat) exists.
 */
function writeProtocolMarker(stateDir, kit) {
  writeJsonAtomic(path.join(stateDir, PROTOCOL_MARKER_FILE), {
    protocol: PROTOCOL_VERSION,
    capabilities: [...CAPABILITIES],
    kit,
  });
}

/** The marker, or null when it is missing or malformed. */
function readProtocolMarker(stateDir) {
  const m = readJson(path.join(stateDir, PROTOCOL_MARKER_FILE));
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  if (!Number.isInteger(m.protocol) || typeof m.kit !== "string") return null;
  if (!Array.isArray(m.capabilities) || !m.capabilities.every((c) => typeof c === "string"))
    return null;
  return { protocol: m.protocol, capabilities: m.capabilities, kit: m.kit };
}

// Every kind of file a wrapper run writes under <main>/.planning/codex/. In-repo state is
// used only where git ignores ALL of these (the `git check-ignore` call stays in the wrapper).
const STATE_PROBES = [
  "reports/x-review.json",
  "reports/x-review.md",
  "reports/x-task.json",
  "sessions/x.json",
  "live/x-task.log",
  "live/x-task.jsonl",
  "live/current.log",
  "live/.current.1.tmp",
  "pending-resume.json",
  "x.json.1.tmp",
].map((p) => `.planning/codex/${p}`);

/** `<name>-<hash>`: the user-level per-project directory name for a main checkout path. */
function projectDirName(main) {
  const name =
    path
      .basename(main)
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .slice(0, 40) || "project";
  const hash = createHash("sha256").update(main).digest("hex").slice(0, 10);
  return `${name}-${hash}`;
}

/**
 * Both places the wrapper may keep a project's run records: in the repo when git ignores the
 * probes, else under the user-level bridge state. A reader scans both and merges.
 */
function projectStateCandidates(main, stateDir) {
  return [
    path.join(main, ".planning", "codex"),
    path.join(stateDir, "projects", projectDirName(main)),
  ];
}

/** Removes claimed requests, TUI status files and stray prompts older than `keepMs`. */
function pruneClaimed(stateDir, now = Date.now(), keepMs = CLAIMED_KEEP_MS) {
  const all = dirs(stateDir);
  for (const d of [all.claimed, all.tui, all.prompts]) {
    let names;
    try {
      names = fs.readdirSync(d);
    } catch {
      continue;
    }
    for (const name of names) {
      const f = path.join(d, name);
      try {
        if (now - fs.statSync(f).mtimeMs > keepMs) fs.unlinkSync(f);
      } catch {}
    }
  }
}

const ANTIGRAVITY_APP = "/Applications/Antigravity IDE.app";
const ANTIGRAVITY_BIN = path.join("Contents", "Resources", "app", "bin", "antigravity-ide");

function isExecutable(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * The Antigravity IDE CLI, or null when Antigravity is not installed.
 * CODEX_BRIDGE_ANTIGRAVITY_CLI (empty = none) > `antigravity-ide` on PATH > the app bundle
 * (CODEX_BRIDGE_ANTIGRAVITY_APP overrides the bundle location, for tests).
 */
function antigravityCli(env = process.env) {
  if (env.CODEX_BRIDGE_ANTIGRAVITY_CLI !== undefined) {
    const p = env.CODEX_BRIDGE_ANTIGRAVITY_CLI;
    return p && isExecutable(p) ? p : null;
  }
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    const p = dir ? path.join(dir, "antigravity-ide") : "";
    if (p && isExecutable(p)) return p;
  }
  const app = path.join(env.CODEX_BRIDGE_ANTIGRAVITY_APP || ANTIGRAVITY_APP, ANTIGRAVITY_BIN);
  return isExecutable(app) ? app : null;
}

module.exports = {
  PROTOCOL_MARKER_FILE,
  STATE_PROBES,
  coveringHeartbeat,
  coveringHeartbeats,
  writeProtocolMarker,
  readProtocolMarker,
  projectDirName,
  projectStateCandidates,
  antigravityCli,
  RUN_ID_RE,
  REQUEST_FILE_RE,
  UUID_RE,
  KINDS,
  MODES,
  ROLES,
  AGENTS,
  PROTOCOL_VERSION,
  CAPABILITIES,
  AGENT_ARGV_MAX,
  AGENT_ELEMENT_MAX,
  AGENT_ENV_MAX,
  AGENT_ENV_VALUE_MAX,
  AGENT_ENV_KEY_RE,
  AGENT_REASONS,
  BANNED_TOKENS,
  TTL_MS,
  FUTURE_SKEW_MS,
  HEARTBEAT_FRESH_MS,
  CONTAIN_DELAY_MS,
  CLAIMED_KEEP_MS,
  validateAgentShape,
  bridgeStateDir,
  bridgeCommand,
  dirs,
  ensureDirs,
  isInside,
  validateRequest,
  matchScore,
  claim,
  scanRequests,
  readClaimed,
  terminalOptions,
  writeRequest,
  writeHeartbeat,
  removeHeartbeat,
  windowCovers,
  pruneClaimed,
};
