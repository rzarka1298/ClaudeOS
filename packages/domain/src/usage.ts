import { z } from "zod";

/** The three summary ranges (PR-23), in display order. */
export const USAGE_RANGES = ["today", "last-7-days", "this-month"] as const;
export type UsageRangeKind = (typeof USAGE_RANGES)[number];

/** Signature stubs (RED): every schema below rejects everything. */
export const UsageBoundsSchema = z.never();
export const TokenCountersSchema = z.never();
export const PlanCapacitySchema = z.never();
export const TokenActivitySchema = z.never();
export const EstimatedApiCostSchema = z.never();
export const UsageSummarySchema = z.never();
export const SessionUsageSchema = z.never();
