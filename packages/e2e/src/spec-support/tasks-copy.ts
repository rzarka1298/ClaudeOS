export type CopyKind = "literal" | "fragment";
export type CopyTable = Readonly<Record<string, readonly [string, string, CopyKind]>>;

export const TASKS_TEXT_TABLE: CopyTable = {};
export const TASKS_CLASSES_TABLE: CopyTable = {};
export const TASKS_TEXT = {
  createTask: "",
  addToInbox: "",
  addAsReady: "",
  markDone: "",
  accept: "",
  dismiss: "",
  attentionHeading: "",
  tasksHeading: "",
};

export function findCopyDrift(_table: CopyTable, _read: (path: string) => string): string[] {
  throw new Error("not implemented");
}
