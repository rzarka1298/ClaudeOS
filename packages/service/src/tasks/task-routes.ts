import { TASK_CREATE_PATH } from "@ccc/domain";
import { type Handler, INTERNAL_ERROR_BODY, sendJson, withAuth } from "../route-kit.js";

/** Skeleton: delivers nothing yet (plan 06-20 Task 1, RED). */
const createHandler: Handler = withAuth((req, res) => {
  req.resume();
  sendJson(res, 500, INTERNAL_ERROR_BODY);
});

/** The task route table, spread into the one route table last (R-ROUTEKIT). */
export const taskRoutes: Record<string, Record<string, Handler>> = {
  [TASK_CREATE_PATH]: { POST: createHandler },
};
