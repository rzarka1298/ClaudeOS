export function installNotificationSpy(): boolean {
  return false;
}
export function readNotifications(): {
  installed: boolean;
  permission: string | null;
  records: unknown[];
} {
  return { installed: true, permission: "x", records: [{}] };
}
export function fireNotificationClick(_index: number): boolean {
  return false;
}
export function installLongtaskObserver(): boolean {
  return false;
}
export function readLongtasks(): { supported: boolean; entries: unknown[] } {
  return { supported: true, entries: [{}] };
}
export function resetLongtasks(): boolean {
  return false;
}
export function installConsoleCapture(): boolean {
  return false;
}
export function readConsoleErrors(): Array<{ kind: string; message: string }> {
  return [];
}
export function clearConsoleErrors(): boolean {
  return false;
}
export function stubDocumentHasFocus(_value: boolean): boolean {
  return false;
}
export function restoreDocumentHasFocus(): boolean {
  return true;
}
