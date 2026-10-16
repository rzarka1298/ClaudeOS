import type { ResearchRouteResult, ResearchRouteServices } from "./types.js";

/**
 * The late-bound research route services (plan 07-14, wave 4 review: construct once, after the
 * port is bound).
 *
 * The request listener is built before the socket is bound, but the research services must be
 * constructed only AFTER the bind: creating them sweeps any run still marked in flight to stale,
 * and a second service instance that lost the bind must never do that to the run of the instance
 * that holds the socket. So the listener is handed this slot; until `bind` it answers the closed
 * `service-disconnected` code, and `bind` accepts the real services exactly once per process (a
 * second bind is a programming error and throws).
 */
export interface ResearchRouteSlot {
  /** What the request listener holds. */
  readonly services: ResearchRouteServices;
  /** True once the real services are bound. */
  isBound(): boolean;
  /** Binds the real services. @throws when called a second time. */
  bind(services: ResearchRouteServices): void;
}

const DISCONNECTED = { ok: false, code: "service-disconnected" } as const;

export function createResearchRouteSlot(): ResearchRouteSlot {
  let bound: ResearchRouteServices | null = null;
  const through = <T>(use: (services: ResearchRouteServices) => ResearchRouteResult<T>) =>
    bound === null ? DISCONNECTED : use(bound);
  return {
    services: {
      run: () => through((services) => services.run()),
      list: (request) => through((services) => services.list(request)),
      report: (request) => through((services) => services.report(request)),
      status: () => through((services) => services.status()),
    },
    isBound: () => bound !== null,
    bind(services) {
      if (bound !== null) throw new Error("the research services are already bound");
      bound = services;
    },
  };
}
