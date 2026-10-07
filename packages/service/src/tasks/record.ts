import type { TaskFrontmatter } from "@ccc/domain";
import type { TaskIndexRecord } from "@ccc/operational-store";

/**
 * Turns one parsed task note into the index record the task store keeps (plan
 * 06-20). Filter keys only: no body text, and the path stays vault-relative.
 * `contentHash` is the SHA-256 of the WHOLE file (06-15), never of the body, so
 * a metadata-only edit changes it.
 *
 * Shared by create, the changed route and the rebuild, so all three index a
 * note identically.
 */
export function toIndexRecord(
  path: string,
  frontmatter: TaskFrontmatter,
  contentHash: string,
): TaskIndexRecord {
  const fm = frontmatter;
  return {
    noteId: fm.id,
    path,
    scope: fm.scope,
    ...(fm.projectId === undefined ? {} : { projectId: fm.projectId }),
    title: fm.title,
    status: fm.status,
    ...(fm.priority === undefined ? {} : { priority: fm.priority }),
    ...(fm.due === undefined ? {} : { due: fm.due }),
    ...(fm.scheduled === undefined ? {} : { scheduled: fm.scheduled }),
    ...(fm.completed === undefined ? {} : { completed: fm.completed }),
    createdAt: fm.created,
    updatedAt: fm.updated,
    ...(fm.parent === undefined ? {} : { parentId: fm.parent }),
    sourceType: fm.sourceType,
    ...(fm.assignee === undefined ? {} : { assignee: fm.assignee }),
    contentHash,
    tags: fm.tags,
    dependencies: fm.dependencies,
    ...(fm.decision === undefined ? {} : { decision: fm.decision }),
    aiGenerated: fm.aiGenerated,
    claimType: fm.claimType ?? null,
    confidence: fm.confidence,
  };
}
