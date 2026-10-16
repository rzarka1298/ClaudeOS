import { isVaultRelativeMarkdownPath } from "@ccc/domain/research-routes.js";
import type { HostRegistry } from "../host-registry.js";
import { capText } from "../view/research-format.js";
import { configureResearch } from "./api.js";
import { createResearchApi, type ResearchClientLike } from "./client-api.js";
import { createResearchEventHandler, installResearchEventHandler } from "./events.js";
import { createRunNowRequester } from "./run-now.js";

/**
 * Connects the Research code to Obsidian and the service (plan 07-15; D-22, PLUG-04, UI-SPEC R2
 * and R6; the `tasks/wiring.ts` precedent). Everything the view may do to the host goes through
 * the four ports installed here, and the registration is released through the host registry:
 *
 * - the API is the research client behind the closed-code adapter;
 * - the notice port is the host's Notice, with the text neutralised and capped, because a report
 *   title is model- and source-derived text;
 * - the open-note port opens a vault-relative Markdown path through the host and nothing else: a
 *   path of any other shape never reaches the host (T-07-07), and a host that fails answers false;
 * - the copy port writes the text it is given through the host's clipboard;
 * - `requestRunNow` is one dispatch of the `research:run` descriptor through `dispatchQuickAction`
 *   (D-17, T-07-42).
 *
 * It also installs the single `research.updated` handler. Installing replaces any earlier one, and
 * a disposer only removes what its own wiring installed, so a reload that loads before the previous
 * unload has finished still ends with one live handler and one configuration.
 */

/** The longest Notice text posted. A title is at most 200 characters, so this is never reached by honest text. */
const NOTICE_MAX = 300;

export interface WireResearchDeps {
  /** The research client built from the authenticated connection (injected, never imported by value here). */
  readonly client: ResearchClientLike;
  /** Posts an Obsidian Notice. */
  readonly notice: (message: string) => void;
  /**
   * Opens a vault file by its exact vault-relative path (a lookup, never link-text parsing).
   * Resolves false when there is no such file.
   */
  readonly openFile: (path: string) => boolean | Promise<boolean>;
  /** Writes text to the clipboard. */
  readonly copyText: (text: string) => void | Promise<void>;
}

export interface ResearchWiring {
  /** Releases the ports and the handler this wiring installed. Safe to call twice. */
  readonly dispose: () => void;
}

/** The wiring whose configuration is live, so a late disposer from an older wiring does nothing. */
let live: symbol | null = null;

export function wireResearch(registry: HostRegistry, deps: WireResearchDeps): ResearchWiring {
  const mine = Symbol("research-wiring");
  const notify = (message: string): void => {
    deps.notice(capText(message, NOTICE_MAX).text);
  };

  configureResearch({
    api: createResearchApi(deps.client),
    notify,
    openNote: async (path) => {
      if (!isVaultRelativeMarkdownPath(path)) return false;
      try {
        return await deps.openFile(path);
      } catch {
        return false;
      }
    },
    copyText: async (text) => {
      try {
        await deps.copyText(text);
        return true;
      } catch {
        return false;
      }
    },
    requestRunNow: createRunNowRequester(notify),
  });
  live = mine;
  const disposeHandler = installResearchEventHandler(createResearchEventHandler());

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    disposeHandler();
    if (live === mine) {
      live = null;
      configureResearch(null);
    }
  };
  registry.cleanup(dispose);
  return { dispose };
}
