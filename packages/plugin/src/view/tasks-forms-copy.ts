/**
 * Fixed strings for the task create form, the detail and edit pane and the
 * notes-need-attention list (plan 06-19, UI-SPEC S3). Skeleton: the wording
 * arrives with the implementation.
 */

export const ADD_TO_INBOX_LABEL = "";
export const ADD_AS_READY_LABEL = "";
export const CLOSE_FORM_LABEL = "";
export const ADDING_STATUS = "";
export const TAGS_HELP = "";
export const FIELD_LABELS = {
  title: "",
  description: "",
  priority: "",
  due: "",
  dueTime: "",
  scheduled: "",
  project: "",
  scope: "",
  tags: "",
} as const;
export const NO_PROJECT_LABEL = "";
export const GLOBAL_SCOPE_LABEL = "";

export function addedMessage(_title: string, _intent: "inbox" | "ready"): string {
  return "";
}
