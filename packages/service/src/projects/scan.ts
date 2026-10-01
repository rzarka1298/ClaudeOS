import type {
  ProjectId,
  RegisterProjectResponse,
  ScanRootId,
  ScanStateResponse,
} from "@ccc/domain";
import type { OperationalStore } from "@ccc/operational-store";
import type { RegistrationPolicyContext } from "./registration.js";

/** RED stub (plan 04-13 Task 1): the interface only. */

export interface ScanProjectsPort {
  onRegistryChanged(): void;
  refresh(projectId?: ProjectId): void;
}

export interface ScanServiceDeps {
  readonly store: OperationalStore;
  readonly homeDir: string;
  readonly readPolicy: () => RegistrationPolicyContext;
  readonly projects?: ScanProjectsPort | undefined;
}

export type ScanStateOutcome =
  | { readonly kind: "state"; readonly state: ScanStateResponse }
  | { readonly kind: "refused" }
  | { readonly kind: "unknown" };

export type SuggestionRegisterOutcome =
  | { readonly kind: "response"; readonly body: RegisterProjectResponse }
  | { readonly kind: "refused" }
  | { readonly kind: "unknown" };

export interface ScanService {
  add(
    path: string,
    options: { readonly depth?: number | undefined; readonly acknowledged: boolean },
  ): Promise<ScanStateOutcome>;
  remove(scanRootId: ScanRootId): ScanStateOutcome;
  rescan(scanRootId: ScanRootId, depth?: number): Promise<ScanStateOutcome>;
  state(): ScanStateResponse;
  registerSuggestion(suggestionId: string): Promise<SuggestionRegisterOutcome>;
  dismiss(suggestionId: string): boolean;
}

export function createScanService(_deps: ScanServiceDeps): ScanService {
  const empty: ScanStateResponse = { scanRoots: [], suggestions: [], partial: false };
  return {
    add: () => Promise.resolve({ kind: "refused" }),
    remove: () => ({ kind: "unknown" }),
    rescan: () => Promise.resolve({ kind: "unknown" }),
    state: () => empty,
    registerSuggestion: () => Promise.resolve({ kind: "unknown" }),
    dismiss: () => false,
  };
}
