import { signal } from "@preact/signals";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";

/**
 * Settings actions that outlive the section that started them (FIX2B m4).
 *
 * The Settings destination shows one section at a time, so a section unmounts when the owner
 * switches away. A rebuild that is running, or a switch or select whose save is pending, is
 * still happening: coming back must find the control busy (and refuse a second press), not idle
 * and ready to start the same action again. The in-flight set is held here, keyed by action, in
 * memory only: it is the same for every view (the action is one service call), and it is never
 * persisted.
 */

const running = signal<ReadonlySet<string>>(new Set());
const results = signal<Readonly<Record<string, string>>>({});

/** Clears every in-flight action and held result. For tests; the plugin never needs it. */
export function resetPendingActions(): void {
  running.value = new Set();
  results.value = {};
}

function begin(key: string): boolean {
  if (running.peek().has(key)) return false;
  running.value = new Set(running.peek()).add(key);
  return true;
}

function end(key: string): void {
  const next = new Set(running.peek());
  next.delete(key);
  running.value = next;
}

/** The outcome line the last run of `key` left (read during render, so it re-renders). */
export function useActionResult(key: string): string | null {
  return results.value[key] ?? null;
}

/** Holds the outcome line of `key`; it survives the section unmounting. */
export function setActionResult(key: string, text: string): void {
  results.value = { ...results.value, [key]: text };
}

export interface ActionGate {
  /** An action under this gate is in flight, started here or before this section mounted. */
  readonly busy: boolean;
  /** Claims the gate. `false` when it is already claimed: the caller must not start the action. */
  readonly begin: () => boolean;
  readonly end: () => void;
}

/**
 * The gate for one action. With a `key` the in-flight state is shared (and so survives a section
 * switch); without one it is local to the component, exactly as a plain `useState` would be.
 * `onAdoptedSettled` runs when an action that was already running when this component mounted
 * finishes: the component that started it is gone, so nothing else will tell this one to take
 * the final value.
 */
export function useActionGate(key: string | undefined, onAdoptedSettled?: () => void): ActionGate {
  const [localBusy, setLocalBusy] = useState(false);
  const localRef = useRef(false);
  const sharedBusy = key !== undefined && running.value.has(key);
  const busy = key === undefined ? localBusy : sharedBusy;

  const adopted = useRef(sharedBusy);
  const settled = useRef(onAdoptedSettled);
  settled.current = onAdoptedSettled;
  useEffect(() => {
    if (busy || !adopted.current) return;
    adopted.current = false;
    settled.current?.();
  }, [busy]);

  const claim = useCallback((): boolean => {
    if (key === undefined) {
      if (localRef.current) return false;
      localRef.current = true;
      setLocalBusy(true);
      return true;
    }
    return begin(key);
  }, [key]);

  const release = useCallback((): void => {
    if (key === undefined) {
      localRef.current = false;
      setLocalBusy(false);
      return;
    }
    end(key);
  }, [key]);

  return { busy, begin: claim, end: release };
}
