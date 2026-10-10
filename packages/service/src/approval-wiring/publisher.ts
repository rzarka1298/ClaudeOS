import {
  type ApprovalLog,
  type ApprovalPublisher,
  type ApprovalUpsertedPayload,
  ApprovalUpsertedPayloadSchema,
} from "@ccc/domain";
import type { EventBus } from "../events/event-bus.js";
import { logger } from "../logging.js";

/**
 * Announces a changed approval request to every connected client (plan 06-13,
 * D-28, APPR-07): one `approval.upserted` event per committed transition.
 *
 * The engine calls this only AFTER the store transaction committed, never
 * inside it, so an event can never describe a state the store does not hold.
 * The payload is the summary and nothing else: it is re-parsed through the
 * domain schema, which drops any member a summary is not defined to carry, so a
 * payload, diff, reason or target cannot ride along even if a caller handed one
 * over (T-06-27). A throwing bus is caught and logged by error class name
 * only; a lost announcement is repaired by the next snapshot.
 */

const serviceLog: ApprovalLog = {
  info: (fields, message) => logger.info(fields, message),
  warn: (fields, message) => logger.warn(fields, message),
  error: (fields, message) => logger.error(fields, message),
};

export function createApprovalPublisher(
  bus: Pick<EventBus, "publish">,
  log: ApprovalLog = serviceLog,
): ApprovalPublisher {
  return {
    publish(event, payload: ApprovalUpsertedPayload) {
      const parsed = ApprovalUpsertedPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        // Fixed reason only: the schema issue text can quote the offending value.
        log.warn({ reason: "invalid-summary" }, "approval event dropped");
        return;
      }
      try {
        bus.publish(event, parsed.data);
      } catch (err: unknown) {
        log.error(
          { errorName: err instanceof Error ? err.name : typeof err },
          "approval event publish failed",
        );
      }
    },
  };
}
