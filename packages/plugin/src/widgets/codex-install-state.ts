import { signal } from "@preact/signals";

/** Unknown until the card adopts integration status; only false shows setup copy. */
export const codexInstalled = signal<boolean | null>(null);

export function setCodexInstalled(installed: boolean): void {
  codexInstalled.value = installed;
}

export function resetCodexInstalled(): void {
  codexInstalled.value = null;
}
