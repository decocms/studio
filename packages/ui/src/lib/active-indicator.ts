/**
 * A ref callback for the indicator that keeps `--active-x` / `--active-w` on its
 * parent pointing at the child matching `selector`, so it can slide between
 * them. On the indicator so a caller's ref on the parent stays theirs.
 * Sets `data-ready` after the first placement so only moves animate.
 */
export function trackActive(selector: string) {
  return (indicator: HTMLElement | null) => {
    const container = indicator?.parentElement;
    if (!container) return;
    const update = () => {
      const active = container.querySelector<HTMLElement>(selector);
      container.style.setProperty("--active-x", `${active?.offsetLeft ?? 0}px`);
      container.style.setProperty(
        "--active-w",
        `${active?.offsetWidth ?? 0}px`,
      );
      container.toggleAttribute("data-has-active", Boolean(active));
    };
    update();
    const frame = requestAnimationFrame(() => {
      container.dataset.ready = "";
    });
    const mutations = new MutationObserver(update);
    mutations.observe(container, {
      subtree: true,
      childList: true,
      attributeFilter: ["data-state"],
    });
    const resizes = new ResizeObserver(update);
    resizes.observe(container);
    return () => {
      cancelAnimationFrame(frame);
      mutations.disconnect();
      resizes.disconnect();
    };
  };
}

/** Classes for the sliding element itself; position it with top/bottom. */
export const ACTIVE_INDICATOR =
  "pointer-events-none absolute left-0 w-[var(--active-w)] translate-x-[var(--active-x)] in-data-ready:transition-[translate,width] in-data-ready:duration-200 in-data-ready:ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none";
