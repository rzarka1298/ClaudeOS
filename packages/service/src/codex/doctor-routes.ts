import type { Handler } from "../route-kit.js";
import type { DoctorRunResult } from "./doctor-probe.js";
import type { DepsGetter } from "./route-support.js";

/**
 * The owner-triggered doctor route (plan 05.1-21, CODEX-03). Signature stub;
 * the implementation lands in the green commit of task 3.
 */

export interface DoctorRouteDeps {
  run(): Promise<DoctorRunResult>;
}

export function doctorRoutes(
  _getDeps: DepsGetter<DoctorRouteDeps>,
): Record<string, Record<string, Handler>> {
  return {};
}
