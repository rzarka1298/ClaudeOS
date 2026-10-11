export const SQLITE_TOOL = "sqlite3";
export const AUDIT_ROWS_SQL = "";
export const EFFECTS_PER_PROPOSAL_SQL = "";
export const EFFECT_COUNT_SQL = "";
export const EXPIRED_EVENTS_SQL = "";
export function assertCopyPath(_p: string): void {}
export function copyStore(_i: { runtimeDir: string; destDir: string }): { copyPath: string } { return { copyPath: "" }; }
export async function queryStore(_i: { copyPath: string; sql: string; deps?: unknown }): Promise<unknown[]> { return []; }
