/**
 * `window.matchMedia` for jsdom, wired up by `packages/plugin/vitest.config.ts`
 * as a `test.setupFiles` entry.
 *
 * It exists for the same reason `obsidian-stub.ts` does: jsdom 30 ships no
 * `matchMedia` at all (verified this session — `typeof window.matchMedia ===
 * "undefined"`), so any module that subscribes to a media query cannot execute
 * under the test runner without a stand-in. One shared, reviewable double
 * declared in one place is deliberately preferred over per-test
 * `vi.stubGlobal` calls: a single double cannot drift test-by-test.
 *
 * Deliberately minimal. It models exactly two facts — what the OS currently
 * says, and who asked to be told when that changes — because those are the
 * only two facts `attachOsMotionPreference` reads. It does NOT parse the query
 * string: every query this plugin opens is the one reduced-motion query, and a
 * fake that pretended to evaluate arbitrary media conditions would be modelling
 * a browser it cannot observe.
 */

type Listener = (event: { matches: boolean; media: string }) => void;

/** The single boolean every stand-in list reads — "does the OS ask to reduce?". */
let prefersReduced = false;

const listeners = new Set<Listener>();

interface MediaQueryListStub {
  matches: boolean;
  media: string;
  onchange: Listener | null;
  addEventListener(type: string, listener: Listener): void;
  removeEventListener(type: string, listener: Listener): void;
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
  dispatchEvent(event: { type: string }): boolean;
}

function createMediaQueryList(media: string): MediaQueryListStub {
  return {
    get matches() {
      return prefersReduced;
    },
    media,
    onchange: null,
    addEventListener(type, listener) {
      if (type === "change") listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === "change") listeners.delete(listener);
    },
    // The deprecated pre-2019 pair, kept because a MediaQueryList still
    // carries it and a consumer written against the old shape must not
    // silently observe nothing.
    addListener(listener) {
      listeners.add(listener);
    },
    removeListener(listener) {
      listeners.delete(listener);
    },
    dispatchEvent() {
      return true;
    },
  };
}

/**
 * Flips what the OS reports and notifies every live listener, exactly as a
 * real `MediaQueryList` does when the user toggles the accessibility setting.
 * Setting the same value still notifies: the production code must be correct
 * under a redundant change event, not merely under a distinct one.
 */
export function setPrefersReducedMotion(value: boolean): void {
  prefersReduced = value;
  for (const listener of [...listeners]) {
    listener({ matches: prefersReduced, media: "(prefers-reduced-motion: reduce)" });
  }
}

/** Drops every subscription and resets the OS answer — for a test's own teardown. */
export function resetPrefersReducedMotion(): void {
  prefersReduced = false;
  listeners.clear();
}

/** Live listener count, so a test can assert a subscription was released. */
export function reducedMotionListenerCount(): number {
  return listeners.size;
}

if (typeof window !== "undefined" && typeof window.matchMedia === "undefined") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (media: string) => createMediaQueryList(media),
  });
}
