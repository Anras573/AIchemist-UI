import { useEffect, useRef, useState } from "react";

/**
 * Trailing-edge throttle for a rapidly changing value (e.g. streamed text).
 *
 * Unlike `useDeferredValue`, progress is guaranteed: the returned value is
 * refreshed at most once per `intervalMs` and never starves while the source
 * keeps changing (a deferred render is restarted on every new value, so it can
 * stall for as long as deltas arrive faster than a render completes — issue
 * #291 review). An empty value is passed through immediately so a new turn
 * clears the previous text without waiting for the interval.
 */
export function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [throttled, setThrottled] = useState(value);
  const lastUpdate = useRef(0);

  useEffect(() => {
    if (value === throttled) return;
    const apply = () => {
      lastUpdate.current = Date.now();
      setThrottled(value);
    };
    const wait = intervalMs - (Date.now() - lastUpdate.current);
    if (wait <= 0 || (value as unknown) === "") {
      apply();
      return;
    }
    const timer = setTimeout(apply, wait);
    return () => clearTimeout(timer);
  }, [value, throttled, intervalMs]);

  return throttled;
}
