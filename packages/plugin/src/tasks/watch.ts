import type { HostRegistry } from "../host-registry.js";
import type { CoalescedBatch } from "./coalescer.js";

/** Skeleton: the implementation follows the RED commit (plan 06-18, Task 3). */
export interface OwnWriteLedger {
  record(path: string): void;
  forget(path: string): void;
  isRecent(path: string): boolean;
}
export interface TaskWatchDeps {
  now(): number;
  changed(batch: CoalescedBatch): Promise<unknown>;
  log?(className: string): void;
}
export function createOwnWriteLedger(_now: () => number, _windowMs?: number): OwnWriteLedger {
  return { record: () => {}, forget: () => {}, isRecent: () => false };
}
export function registerTaskVaultWatch(
  _registry: Pick<HostRegistry, "vaultEvent" | "timer" | "cleanup">,
  _deps: TaskWatchDeps,
): { readonly ownWrites: OwnWriteLedger } {
  return { ownWrites: createOwnWriteLedger(_deps.now) };
}
