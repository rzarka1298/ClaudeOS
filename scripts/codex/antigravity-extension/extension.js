// Antigravity IDE (VS Code fork) extension for codex-bridge. Deliberately thin:
// all request handling lives in bridge-core.js, which is unit-tested.
//
// No URI handler, no commands, no network. The extension only watches the
// user-level request queue, claims requests for projects open in this window,
// and opens a terminal that runs the fixed launcher `~/.local/bin/codex-bridge`
// with argv ["follow" | "tui" | "agent", <runId>]. The run id has been checked
// against a strict pattern; nothing else from a request reaches the terminal.
// An agent request (protocol 2) names the program to run, but only the launcher
// reads it, after re-validating it; this file never reads or logs argv or env.
// The heartbeat advertises protocol 2 and the capabilities (see bridge-core.js);
// an extension from before agent mode (0.1.0) writes neither.

const fs = require("node:fs");
const os = require("node:os");
const vscode = require("vscode");
const core = require("./bridge-core.js");

const POLL_MS = 3000;
const HEARTBEAT_MS = 30_000;

let stateDir = null;
let key = null;

function activate(context) {
  stateDir = core.bridgeStateDir(process.env, os.homedir());
  key = `${process.pid}`;
  const command = core.bridgeCommand(os.homedir());
  const out = vscode.window.createOutputChannel("Codex Bridge");
  context.subscriptions.push(out);

  const folders = () =>
    (vscode.workspace.workspaceFolders ?? [])
      .filter((f) => f.uri.scheme === "file")
      .map((f) => f.uri.fsPath);

  let lastBeat = 0;
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    try {
      core.ensureDirs(stateDir);
      const now = Date.now();
      if (now - lastBeat >= HEARTBEAT_MS) {
        core.writeHeartbeat(stateDir, key, folders(), now);
        core.pruneClaimed(stateDir, now);
        lastBeat = now;
      }
      // Without the launcher there is nothing safe to run; leave requests queued.
      if (!fs.existsSync(command)) return;
      for (const request of core.scanRequests({
        stateDir,
        folders: folders(),
        log: (m) => out.appendLine(m),
      })) {
        const terminal = vscode.window.createTerminal(core.terminalOptions(request, command));
        terminal.show(true); // reveal the tab without stealing keyboard focus
        // Kind and run id only: never argv or env (an agent request carries both).
        out.appendLine(`codex-bridge: opened ${request.kind} run ${request.runId}`);
      }
    } catch (err) {
      out.appendLine(`codex-bridge: ${err?.message ?? err}`);
    } finally {
      busy = false;
    }
  };

  core.ensureDirs(stateDir);
  try {
    const watcher = fs.watch(core.dirs(stateDir).requests, () => setTimeout(tick, 50));
    context.subscriptions.push({ dispose: () => watcher.close() });
  } catch {}
  const timer = setInterval(tick, POLL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      lastBeat = 0;
      tick();
    }),
  );
  tick();
}

function deactivate() {
  if (stateDir && key) core.removeHeartbeat(stateDir, key);
}

module.exports = { activate, deactivate };
