import type Database from "better-sqlite3";
import type { ResearchServices } from "./services.js";
import type { ResearchRouteServices } from "./types.js";
import {
  buildReportItemsPage,
  buildReportList,
  buildReportSourcesPage,
  buildResearchStatus,
  findReport,
} from "./view-model.js";

/**
 * The research route services (plan 07-14): the narrow object the routes call. It joins the run
 * services, the job-run store and the vault readers. It is the only thing the route context holds,
 * so a route can start a run and read view models and can do nothing else.
 */

export interface ResearchRouteServicesDeps {
  readonly db: Database.Database;
  /** The managed vault root, or null when no vault has been set up. */
  readonly getVaultRoot: () => string | null;
  readonly services: Pick<ResearchServices, "runNow" | "configuredSources">;
}

export function createResearchRouteServices(
  deps: ResearchRouteServicesDeps,
): ResearchRouteServices {
  return {
    run() {
      const started = deps.services.runNow();
      if (!started.ok) return { ok: false, code: started.code };
      return { ok: true, value: started.value };
    },
    list() {
      const vaultRoot = deps.getVaultRoot();
      if (vaultRoot === null) return { ok: false, code: "vault-not-set-up" };
      return { ok: true, value: buildReportList(vaultRoot) };
    },
    report(request) {
      const vaultRoot = deps.getVaultRoot();
      if (vaultRoot === null) return { ok: false, code: "vault-not-set-up" };
      const entry = findReport(vaultRoot, request.noteId);
      if (entry === null) return { ok: false, code: "not-found" };
      if (request.page === "items") {
        return { ok: true, value: buildReportItemsPage(vaultRoot, deps.db, entry) };
      }
      return { ok: true, value: buildReportSourcesPage(entry) };
    },
    status() {
      return {
        ok: true,
        value: buildResearchStatus(deps.db, deps.services.configuredSources()),
      };
    },
  };
}
