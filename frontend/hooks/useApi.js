import { useCallback, useEffect, useRef, useState } from 'react';

// Shared GET wrapper with abort semantics:
//  - one in-flight request per hook; a new one (url/deps/attempt change)
//    aborts the previous, and unmount aborts whatever is running — so a slow
//    response can never clobber a newer tab's data or set state after
//    unmount (the race the leaderboard fetches used to have);
//  - AbortError is swallowed: it is our own cancellation, not a failure;
//  - non-2xx and body.success === false both surface as `error` (all plankton
//    APIs use the success flag).
// fetchOptions is read through a ref, so passing a fresh object literal each
// render does not retrigger the request — declare what should refetch in deps.
export default function useApi(url, { deps = [], enabled = true, fetchOptions } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const optsRef = useRef(fetchOptions);
  optsRef.current = fetchOptions;

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return undefined;
    }
    const ac = new AbortController();
    let alive = true;
    (async () => {
      try {
        setLoading(true);
        setError(false);
        const res = await fetch(url, { ...(optsRef.current || {}), signal: ac.signal });
        const body = await res.json().catch(() => null);
        if (!alive || ac.signal.aborted) return;
        if (!res.ok || (body && body.success === false)) {
          setData(null);
          setError(true);
        } else {
          setData(body);
        }
      } catch (err) {
        if (!alive || ac.signal.aborted || (err && err.name === 'AbortError')) return;
        setData(null);
        setError(true);
      } finally {
        if (alive && !ac.signal.aborted) setLoading(false);
      }
    })();
    return () => {
      alive = false;
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, enabled, attempt, ...deps]);

  return { data, loading, error, reload };
}
