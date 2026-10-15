import type {
  ResearchErrorCode,
  ResearchListResponse,
  ResearchReportPage,
  ResearchReportResponse,
  ResearchRunResponse,
  ResearchStatusResponse,
} from "@ccc/domain/research-routes.js";

/**
 * The seam between the Research view and the service (plan 07-11; D-23's
 * transport rule, the `tasks/api.ts` and `approvals/api.ts` precedent). The
 * view and its state call these plain functions; the wiring plan (07-15)
 * configures them from the authenticated research client. The service client
 * package is never imported here, because its value exports pull in Node HTTP
 * the browser-platform bundle cannot resolve.
 *
 * Alongside the API sit the HOST ports: the four things the view needs from
 * Obsidian and the shell and must never reach for itself (a Notice, opening a
 * vault note, the clipboard, and the run trigger). One `configureResearch`
 * call installs all of them, and a `null` restores the disconnected default.
 */
export interface ResearchApi {
  /** Starts a run, or answers the one already running (D-19). */
  run: () => Promise<ResearchRunResponse>;
  status: () => Promise<ResearchStatusResponse>;
  /** One page of the report list, newest first. */
  list: (cursor?: string) => Promise<ResearchListResponse>;
  /** One page of one report's view model. */
  report(
    noteId: string,
    page: ResearchReportPage,
    cursor?: string,
  ): Promise<ResearchReportResponse>;
}

export interface ResearchHostPorts {
  /** Posts an Obsidian Notice. Never throws. */
  notify: (message: string) => void;
  /** Opens a vault-relative note. Resolves false when it could not be opened. */
  openNote: (path: string) => boolean | Promise<boolean>;
  /** Writes text to the clipboard. Resolves false when it could not be written. */
  copyText: (text: string) => boolean | Promise<boolean>;
  /**
   * Asks the host to run research now. The shell routes this through
   * `dispatchQuickAction` with the `research:run` descriptor (UI-SPEC R2); the
   * Run now button calls this and nothing else.
   */
  requestRunNow: () => void;
}

/** What `configureResearch` installs: the API and the four host ports. */
export type ResearchConfig = { readonly api: ResearchApi } & ResearchHostPorts;

/**
 * The closed error vocabulary the holder itself raises; the wiring maps client
 * errors onto the same codes. The message equals the code, so nothing a remote
 * party said can reach a string the view might render.
 */
export class ResearchApiError extends Error {
  readonly code: ResearchErrorCode;
  constructor(code: ResearchErrorCode) {
    super(code);
    this.name = "ResearchApiError";
    this.code = code;
  }
}

function disconnected(): Promise<never> {
  return Promise.reject(new ResearchApiError("service-disconnected"));
}

/** The default until the host configures one: every call rejects as if the service were away. */
const DISCONNECTED_API: ResearchApi = {
  run: disconnected,
  status: disconnected,
  list: disconnected,
  report: disconnected,
};

const INERT_PORTS: ResearchHostPorts = {
  notify: () => undefined,
  openNote: () => false,
  copyText: () => false,
  requestRunNow: () => undefined,
};

let currentApi: ResearchApi = DISCONNECTED_API;
let currentPorts: ResearchHostPorts = INERT_PORTS;
let configured = false;

/** Installs the API and the host ports the research code reaches (or, with `null`, the defaults). */
export function configureResearch(config: ResearchConfig | null): void {
  if (config === null) {
    currentApi = DISCONNECTED_API;
    currentPorts = INERT_PORTS;
    configured = false;
    return;
  }
  currentApi = config.api;
  currentPorts = {
    notify: config.notify,
    openNote: config.openNote,
    copyText: config.copyText,
    requestRunNow: config.requestRunNow,
  };
  configured = true;
}

/** True once a host has configured the research code. */
export function researchConfigured(): boolean {
  return configured;
}

/** The configured API: exactly the four functions, nothing else. */
export function researchApi(): ResearchApi {
  return {
    run: () => currentApi.run(),
    status: () => currentApi.status(),
    list: (cursor) => currentApi.list(cursor),
    report: (noteId, page, cursor) => currentApi.report(noteId, page, cursor),
  };
}

/** The configured host ports: exactly the four, nothing else. */
export function researchPorts(): ResearchHostPorts {
  return {
    notify: (message) => {
      try {
        currentPorts.notify(message);
      } catch {
        // A Notice that cannot be shown is never a reason to fail the view.
      }
    },
    openNote: (path) => currentPorts.openNote(path),
    copyText: (text) => currentPorts.copyText(text),
    requestRunNow: () => currentPorts.requestRunNow(),
  };
}
