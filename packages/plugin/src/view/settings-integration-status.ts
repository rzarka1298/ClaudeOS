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
 *
 * `refreshKey` (plan 08-18, moved from the native tab's Codex group) is a counter that a
 * reconnect snapshot bumps: when it changes while the section is open and the service is up, the
 * seam is read again even though a live value is held, because the snapshot may carry no status
 * of its own. The re-read supersedes the held value until the signal next changes; a push that
 * arrives while a re-read is in flight wins, so a slower, older answer never overwrites it.
 */
export function useIntegrationStatus<T>(
  live: T | null,
  away: boolean,
  read: () => Promise<T>,
  refreshKey = 0,
): Read<T> {
  const [fetched, setFetched] = useState<Read<T>>("checking");
  const [refreshed, setRefreshed] = useState<Read<T> | null>(null);
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

  // A newer pushed value supersedes a re-read answer, and a re-read that began before the push is
  // dropped: `pushVersion` counts the pushes the section has seen.
  const pushVersion = useRef(0);
  const lastLive = useRef(live);
  // True for the effects pass of a render in which the signal changed: a snapshot that carried
  // its own status bumps the key and the signal together, and that status is adopted as it is.
  const pushedThisRender = useRef(false);
  if (lastLive.current !== live) {
    lastLive.current = live;
    pushVersion.current += 1;
    pushedThisRender.current = true;
  }
  useEffect(() => {
    if (live !== null) setRefreshed(null);
  }, [live]);

  const handledKey = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey === handledKey.current) return;
    handledKey.current = refreshKey;
    if (away || pushedThisRender.current) return;
    let cancelled = false;
    const startedAt = pushVersion.current;
    new Promise<T>((resolve) => {
      resolve(readRef.current());
    }).then(
      (status) => {
        if (!cancelled && pushVersion.current === startedAt) setRefreshed(status);
      },
      () => {
        if (!cancelled && pushVersion.current === startedAt) setRefreshed("unavailable");
      },
    );
    return () => {
      cancelled = true;
    };
    // Only a new key starts a re-read; `away` is read as of that moment.
  }, [refreshKey]);
  useEffect(() => {
    pushedThisRender.current = false;
  });

  if (away) return live ?? fetched;
  if (refreshed !== null) return refreshed;
  if (live !== null) return live;
  return fetched;
}
