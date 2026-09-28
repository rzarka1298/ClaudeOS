import type { TokenCounters } from "@ccc/domain";
import type Database from "better-sqlite3";

// RED signature stubs (05-05 Task 3): the behavior lands in the GREEN commit.

export interface UsageRecordInput {
  readonly messageId: string;
  readonly claudeSessionId: string;
  readonly timestamp: string;
  readonly model: string;
  readonly skillKey: string | null;
  readonly projectKey: string | null;
  readonly counters: TokenCounters;
}

export class InvalidUsageRecordError extends Error {}

export interface TokenActivityQuery {
  readonly start: string;
  readonly end: string;
  readonly claudeSessionId?: string;
}

export interface TokenActivityRows {
  readonly totals: TokenCounters;
  readonly byProject: ReadonlyArray<{ projectId: string | null; counters: TokenCounters }>;
  readonly byModel: ReadonlyArray<{ model: string; counters: TokenCounters }>;
  readonly bySkill: ReadonlyArray<{ name: string; counters: TokenCounters }>;
}

export type CoverageStatus = "covered" | "before-horizon" | "analysis-off" | "not-scanned";

export interface AnalysisToggle {
  readonly at: string;
  readonly enabled: boolean;
}

export interface TranscriptCursor {
  readonly inode: string;
  readonly size: number;
  readonly offset: number;
}

export interface CapacitySnapshot {
  readonly window: string;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
  readonly observedAt: string;
  readonly claudeSessionId: string | null;
}

export interface CostSnapshot {
  readonly claudeSessionId: string;
  readonly totalCostUsd: number;
  readonly firstObservedAt: string;
  readonly observedAt: string;
}

const ZERO: TokenCounters = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

export function recordUsage(
  _db: Database.Database,
  _records: readonly UsageRecordInput[],
  _seenAt: string,
): number {
  return 0;
}

export function queryTokenActivity(
  _db: Database.Database,
  _query: TokenActivityQuery,
): TokenActivityRows {
  return { totals: ZERO, byProject: [], byModel: [], bySkill: [] };
}

export function markDayCovered(_db: Database.Database, _day: string, _at: string): void {}

export function queryCoverage(
  _db: Database.Database,
  _fromDay: string,
  _toDay: string,
  _horizonDate: string | null,
  _toggleLog: readonly AnalysisToggle[],
  _dayOf?: (iso: string) => string,
): Array<{ day: string; status: CoverageStatus }> {
  return [];
}

export function readCursor(_db: Database.Database, _path: string): TranscriptCursor | null {
  return null;
}

export function writeCursor(
  _db: Database.Database,
  _path: string,
  _cursor: TranscriptCursor,
  _at: string,
): void {}

export function upsertCapacitySnapshot(_db: Database.Database, _snapshot: CapacitySnapshot): void {}

export function latestCapacity(_db: Database.Database): CapacitySnapshot[] {
  return [];
}

export function upsertCostSnapshot(
  _db: Database.Database,
  _snapshot: { claudeSessionId: string; totalCostUsd: number; observedAt: string },
): void {}

export function listCostSnapshots(_db: Database.Database): CostSnapshot[] {
  return [];
}

export function getCollectorSetting(_db: Database.Database, _key: string): string | null {
  return null;
}

export function setCollectorSetting(
  _db: Database.Database,
  _key: string,
  _value: string,
  _at: string,
): void {}

export function appendToggleLog(_db: Database.Database, _at: string, _enabled: boolean): void {}

export function listToggleLog(_db: Database.Database): AnalysisToggle[] {
  return [];
}

export function deleteUsageAnalytics(_db: Database.Database): void {}
