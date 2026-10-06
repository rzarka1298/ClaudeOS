import { realpathSync } from "node:fs";
import { checkPathContainment, type ProjectRef, type SessionProjectLookup } from "@ccc/domain";
import { listRegisteredProjects } from "@ccc/operational-store";
import type Database from "better-sqlite3";

/**
 * The domain `SessionProjectLookup` over the store's registered projects
 * (D-23, D-57), read-only: it lists `projects` and never writes it. Each
 * call reads the current registrations and realpaths their roots once, so
 * a project registered a moment ago is visible to the next resolution. A
 * root that no longer resolves (moved, deleted, unreadable) simply matches
 * nothing. Plan 05-16 replaces this with Phase 4's implementation at the
 * reconcile when the two are equivalent (PR-17).
 */
export function createStoreProjectLookup(db: Database.Database): SessionProjectLookup {
  function list(): ProjectRef[] {
    return listRegisteredProjects(db).map((project) => ({
      projectId: project.projectId,
      name: project.name,
      root: project.root,
    }));
  }

  return {
    list,
    resolveByPath(realPath) {
      let best: { project: ProjectRef; depth: number } | null = null;
      for (const project of list()) {
        let root: string;
        try {
          root = realpathSync.native(project.root);
        } catch {
          continue;
        }
        const containment = checkPathContainment(realPath, root);
        // A strict descendant, or the root itself (containment's is-root).
        const matches =
          containment.contained || (!containment.contained && containment.reason === "is-root");
        if (matches && (best === null || root.length > best.depth)) {
          best = { project, depth: root.length };
        }
      }
      return best?.project ?? null;
    },
  };
}
