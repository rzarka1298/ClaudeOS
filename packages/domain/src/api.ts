import { z } from "zod";

/** The versioned base path every companion-service HTTP route lives under. */
export const API_BASE = "/api/v1";

export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  serviceVersion: z.string(),
  startedAt: z.string(),
  schemaVersion: z.number(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ApiErrorBodySchema = z.object({
  error: z.string(),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;
