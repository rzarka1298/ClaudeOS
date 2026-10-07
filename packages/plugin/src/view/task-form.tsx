import type { TaskCreateRequest } from "@ccc/domain/tasks.js";
import type { VNode } from "preact";

/** A project or workspace the form may choose. `id` is the value stored (a project id, or a scope string). */
export interface TaskFormOption {
  readonly id: string;
  readonly name: string;
}

export interface TaskCreateFormProps {
  readonly connected: boolean;
  readonly zone: string;
  readonly projects: readonly TaskFormOption[];
  readonly workspaces: readonly TaskFormOption[];
  readonly defaultProjectId?: string | undefined;
  readonly defaultScope?: string | undefined;
  readonly create: (request: TaskCreateRequest) => Promise<unknown>;
  readonly onStatus: (text: string) => void;
  readonly onNotice: (text: string) => void;
  readonly onClose: () => void;
  readonly getOpener?: () => HTMLElement | null;
}

/** Skeleton: delivers nothing until the implementation lands. */
export function TaskCreateForm(_props: TaskCreateFormProps): VNode | null {
  return null;
}
