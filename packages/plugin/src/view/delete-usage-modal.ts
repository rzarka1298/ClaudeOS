// RED scaffold (Task 3, TDD). Exports the right shapes so
// delete-usage-modal.test.ts resolves and fails on real assertions rather
// than a module-resolution crash. GREEN replaces every body below.

import type { App } from "obsidian";

export const DELETE_USAGE_MODAL_TITLE = "TODO";
export const DELETE_USAGE_MODAL_BODY_1 = "TODO";
export const DELETE_USAGE_CONFIRM_LABEL = "TODO";
export const DELETE_USAGE_CANCEL_LABEL = "TODO";

export interface DeleteUsageViewModelButton {
  readonly label: string;
  readonly destructive: boolean;
}

export interface DeleteUsageViewModel {
  readonly title: string;
  readonly bodies: readonly [string, string];
  readonly buttons: readonly [DeleteUsageViewModelButton, DeleteUsageViewModelButton];
  readonly initialFocus: "cancel";
}

export function deleteUsageViewModel(_horizonDate: string | null): DeleteUsageViewModel {
  return {
    title: "",
    bodies: ["", ""],
    buttons: [
      { label: "", destructive: false },
      { label: "", destructive: false },
    ],
    initialFocus: "cancel",
  };
}

export class DeleteUsageModal {
  constructor(
    _app: App,
    _horizonDate: string | null,
    _decide: (confirmed: boolean) => void,
  ) {}

  open(): void {}
  close(): void {}
  confirm(): void {}
}

export function openDeleteUsageModal(_app: App, _horizonDate: string | null): Promise<boolean> {
  throw new Error("not implemented");
}
