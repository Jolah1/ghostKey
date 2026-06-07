/**
 * IntersectionObserver-based "track this event when the section first
 * becomes visible" hook. Used by the landing page to measure section
 * drop-off without a third-party pixel.
 *
 * Each hook instance:
 *   - returns a ref the caller spreads onto the section's root element,
 *   - fires `api.trackEvent(event, label?)` exactly once per page load
 *     when the element first crosses ~25% visibility,
 *   - is a no-op if `IntersectionObserver` isn't supported (older WebViews,
 *     prerender contexts) — we'd rather miss a beacon than crash the page.
 *
 * See `crates/ghostkey-server/src/analytics.rs` for the server side and
 * `DESIGN.md` § "What we measure and why" for the privacy posture.
 */
import { useCallback, useEffect, useRef } from "react";
import { api } from "./api";

export function useTrackInView(event: string, label?: string) {
  const fired = useRef(false);
  const cleanup = useRef<(() => void) | null>(null);

  const ref = useCallback(
    (el: HTMLElement | null) => {
      // Tear down any previous observer (e.g. on remount).
      if (cleanup.current) {
        cleanup.current();
        cleanup.current = null;
      }
      if (!el) return;
      if (typeof IntersectionObserver === "undefined") return;
      if (fired.current) return;

      const obs = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && !fired.current) {
              fired.current = true;
              void api.trackEvent(event, label);
              obs.disconnect();
            }
          }
        },
        { threshold: 0.25 },
      );
      obs.observe(el);
      cleanup.current = () => obs.disconnect();
    },
    [event, label],
  );

  useEffect(() => {
    return () => {
      if (cleanup.current) cleanup.current();
    };
  }, []);

  return ref;
}
