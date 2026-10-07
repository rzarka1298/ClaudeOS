import type { TaskServices, TaskServicesDeps } from "./types.js";

/** Skeleton: delivers nothing yet (plan 06-20 Task 1, RED). */
export function createTaskServices(_deps: TaskServicesDeps): TaskServices {
  return {
    create: () => ({ ok: false, code: "write-failed" }),
  };
}
