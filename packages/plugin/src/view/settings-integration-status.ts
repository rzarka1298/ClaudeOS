import { useEffect, useRef, useState } from "preact/hooks";

/**
 * What a Settings section knows about an integration's status (plan 08-15): the live value from a
 * signal, or one of two states before there is one. Shared by the Integrations and Security
 * sections so neither grows a second state machine.
 */
export type Read<T> = T | "checking" | "unavailable";

/**
 * The live value when there is one; otherwise the seam's answer, read once per time the section
 * needs one (mounted with no signal, or the service coming back with no signal). While the
 * service is away nothing is read. A rejected read settles on `unavailable`, never on `checking`
 * forever. The hook starts no timer and makes no request of its own: `read` is the section's seam.
 */
export function useIntegrationStatus<T>(
  live: T | null,
  away: boolean,
  read: () => Promise<T>,
): Read<T> {
  const [fetched, setFetched] = useState<Read<T>>("checking");
  const readRef = useRef(read);
  readRef.current = read;
  const needsRead = live === null && !away;

  useEffect(() => {
    if (!needsRead) return;
    let cancelled = false;
    setFetched("checking");
    // `new Promise` also turns a synchronous throw in the seam into a rejection.
    new Promise<T>((resolve) => {
      resolve(readRef.current());
    }).then(
      (status) => {
        if (!cancelled) setFetched(status);
      },
      () => {
        if (!cancelled) setFetched("unavailable");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [needsRead]);

  if (live !== null) return live;
  return fetched;
}
