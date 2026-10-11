// RED stub: never committed, quoted or attached; PRIV-04 (real implementation follows).
export const SHOTS_PREFIX = "ccc-uat-shots-";
export function createShotsDir(_i: {
  base?: string;
  runId: string;
  repoRoot?: string;
  homeDir?: string;
}): string {
  return "";
}
export function shotPath(_dir: string, _item: number, _label: string): string {
  return "";
}
export function assertShotInside(_dir: string, _file: string): void {}
export function purgeStaleShotDirs(_i: { base: string; keepRunIds: readonly string[] }): string[] {
  return ["stub"];
}
export function deleteShotsDir(_dir: string): boolean {
  return false;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export function regionArgs(_r: Rect, _out: string): string[] {
  return [];
}
export async function captureRegion(_i: {
  shotsDir: string;
  outPath: string;
  rect: Rect;
  deps?: { execFile: (file: string, args: readonly string[]) => Promise<void> };
}): Promise<string> {
  return "";
}
