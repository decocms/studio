import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import { useClockTick } from "@/lib/use-clock-tick";

/**
 * Renders `useClockTick`'s value. The hook returns wall-clock ms as of the last
 * tick, so the rendered number must (a) start close to the real clock and
 * (b) advance on its own.
 *
 * The value sits on a CHILD of the mount root: `component.getByTestId(...)`
 * searches descendants, so a testid on the root itself never matches.
 */
export function ClockTickHarness({ intervalMs }: { intervalMs: number }) {
  const now = useClockTick(intervalMs);
  return (
    <div>
      <span data-testid="now">{now}</span>
    </div>
  );
}

/** Renders `useIsMobile`, which reads the viewport via useSyncExternalStore. */
export function IsMobileHarness() {
  const isMobile = useIsMobile();
  return (
    <div>
      <span data-testid="is-mobile">{isMobile ? "mobile" : "desktop"}</span>
    </div>
  );
}
