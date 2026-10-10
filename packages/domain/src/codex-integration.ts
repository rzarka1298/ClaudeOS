import { z } from "zod";

// RED stub (plan 05.1-03 task 3): signatures only, no behaviour yet.
export const CodexBridgeStatusSchema = Object.assign(z.never(), {
  shape: {} as Record<string, unknown>,
});
export const CodexHookStatusSchema = Object.assign(z.never(), {
  shape: {} as Record<string, unknown>,
});
export const CodexDoctorSummarySchema = z.never();
export const CodexIntegrationStatusSchema = Object.assign(z.never(), {
  shape: {} as Record<string, unknown>,
});
