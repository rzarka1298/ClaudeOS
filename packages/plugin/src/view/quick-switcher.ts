import type { LaunchAction, ProjectId, ProjectsSnapshot } from "@ccc/domain";
import type { EventClient } from "@ccc/service-api-client";
import { type App, FuzzySuggestModal } from "obsidian";
import type { ConnectionState } from "../connection-state.js";
import type { HostRegistry } from "../host-registry.js";
import type { QuickActionDescriptor } from "../widgets/contract.js";
import type { DestinationId } from "./destinations.js";

/** RED skeleton (plan 04-14 Task 1): the shapes exist, the behaviour does not yet. */

export const SWITCHER_COMMAND_ID = "search-projects-and-actions";

export type SwitcherItem =
  | { readonly kind: "destination"; readonly text: string; readonly destination: DestinationId }
  | { readonly kind: "project"; readonly text: string; readonly projectId: ProjectId }
  | {
      readonly kind: "launch";
      readonly text: string;
      readonly action: LaunchAction;
      readonly projectId: ProjectId | null;
      readonly projectName: string | null;
      readonly descriptor: QuickActionDescriptor;
      readonly noGithubRemote: boolean;
    };

export interface SwitcherHost {
  snapshot(): ProjectsSnapshot | undefined;
  connection(): ConnectionState;
  notify(message: string): void;
  goTo(destination: DestinationId, focusProjectId?: ProjectId): void;
  requestLaunch(projectId: ProjectId | null, action: LaunchAction): void;
  openSwitcher(prefill: string): void;
}

export function buildSwitcherItems(_snapshot: ProjectsSnapshot | undefined): SwitcherItem[] {
  return [];
}

export class ProjectSwitcherModal extends FuzzySuggestModal<SwitcherItem> {
  constructor(app: App, _host: SwitcherHost) {
    super(app);
  }

  getItems(): SwitcherItem[] {
    return [];
  }

  getItemText(item: SwitcherItem): string {
    return item.text;
  }

  onChooseItem(_item: SwitcherItem, _evt: MouseEvent | KeyboardEvent): void {}

  openWith(_prefill: string): void {
    this.open();
  }
}

export interface SwitcherOpenerOptions {
  readonly eventClient: EventClient;
  readonly onLive?: (() => void) | undefined;
  readonly show: (prefill: string) => void;
}

export function createSwitcherOpener(options: SwitcherOpenerOptions): (prefill: string) => void {
  return (prefill) => options.show(prefill);
}

export function registerSwitcherCommand(
  _registry: HostRegistry,
  _open: (prefill: string) => void,
): void {}
