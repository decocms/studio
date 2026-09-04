import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";

type NavigationFocusSource =
  | "chat-panel-toggle"
  | "main-panel-toggle"
  | "mobile-view-select"
  | "route";

interface NavigationFocusRequest {
  destinationHref: string;
  pathChanged: boolean;
  source: HTMLElement | null;
  sourceRoot: HTMLElement | null;
  sourceType: NavigationFocusSource | null;
  onlyIfFocusLost: boolean;
}

const MOBILE_VIEW_SELECT_SOURCE =
  '[data-route-focus-source="mobile-view-select"]';
const ROUTE_CONTROL_SOURCE = '[data-route-focus-source="route"]';
const ROUTE_HEADING = '[data-testid="main-panel"] h1, [data-slot="main"] h1';
const MAIN_PANEL_CONTROL = '[aria-controls="workspace-main-panel"]';
const CHAT_PANEL_CONTROL = '[aria-controls="workspace-side-panel"]';
const SHOW_MAIN_PANEL_CONTROL = `${MAIN_PANEL_CONTROL}[aria-expanded="false"]`;
const RESPONSIVE_FOCUS_GROUP = "[data-responsive-focus-group]";
const WORKSPACE_PANEL =
  '[data-testid="main-panel"], [data-testid="side-panel"]';
const RESPONSIVE_FOCUSABLE = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function elementIsVisible(element: HTMLElement): boolean {
  if (!element.isConnected || element.getClientRects().length === 0) {
    return false;
  }
  if (element.closest('[inert], [aria-hidden="true"]')) return false;

  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

function visibleElement(selector: string): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>(selector)) {
    if (elementIsVisible(element)) return element;
  }
  return null;
}

function responsiveFocusTarget(
  group: string,
  remembered: HTMLElement | null,
): HTMLElement | null {
  if (remembered && elementIsVisible(remembered)) return remembered;

  for (const root of document.querySelectorAll<HTMLElement>(
    RESPONSIVE_FOCUS_GROUP,
  )) {
    if (root.dataset.responsiveFocusGroup !== group) continue;
    if (root.matches(RESPONSIVE_FOCUSABLE) && elementIsVisible(root)) {
      return root;
    }
    for (const candidate of root.querySelectorAll<HTMLElement>(
      RESPONSIVE_FOCUSABLE,
    )) {
      if (elementIsVisible(candidate)) return candidate;
    }
  }
  return null;
}

function activeNavigationSource(): {
  element: HTMLElement;
  root: HTMLElement;
  type: NavigationFocusSource;
} | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;

  const mobileSelect = active.closest<HTMLElement>(MOBILE_VIEW_SELECT_SOURCE);
  if (mobileSelect) {
    return { element: active, root: mobileSelect, type: "mobile-view-select" };
  }

  const panelControl = active.closest<HTMLElement>(
    `${MAIN_PANEL_CONTROL}, ${CHAT_PANEL_CONTROL}`,
  );
  if (panelControl) {
    return {
      element: active,
      root: panelControl,
      type:
        panelControl.getAttribute("aria-controls") === "workspace-side-panel"
          ? "chat-panel-toggle"
          : "main-panel-toggle",
    };
  }

  const routeControl = active.closest<HTMLElement>(ROUTE_CONTROL_SOURCE);
  if (routeControl) {
    return { element: active, root: routeControl, type: "route" };
  }

  const link = active.closest<HTMLElement>("a[href]");
  if (link) return { element: active, root: link, type: "route" };

  const breadcrumb = active.closest<HTMLElement>(
    '[data-slot="main-breadcrumb"]',
  );
  if (breadcrumb) return { element: active, root: breadcrumb, type: "route" };

  return null;
}

function hasUsableFocus(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body)
    return false;
  return elementIsVisible(active);
}

function focusIsInRouteChrome(active: Element | null): boolean {
  return Boolean(
    active instanceof HTMLElement &&
      active.closest(
        `${MOBILE_VIEW_SELECT_SOURCE}, ${ROUTE_CONTROL_SOURCE}, [data-slot="main-breadcrumb"]`,
      ),
  );
}

function focusRouteTarget(target: HTMLElement): void {
  const needsTemporaryTabIndex =
    !target.matches(RESPONSIVE_FOCUSABLE) && !target.hasAttribute("tabindex");
  if (needsTemporaryTabIndex) target.setAttribute("tabindex", "-1");

  target.focus({ preventScroll: true });

  if (needsTemporaryTabIndex) {
    target.addEventListener(
      "blur",
      () => {
        if (target.getAttribute("tabindex") === "-1") {
          target.removeAttribute("tabindex");
        }
      },
      { once: true },
    );
  }
}

/**
 * Restores a meaningful focus position after route-owned controls replace
 * themselves. Persistent navigation keeps its focus; dialogs and other
 * components may perform their own handoff. We intervene only when focus was
 * still owned by the activating control (or was lost with it).
 */
export function RouteNavigationFocus() {
  const router = useRouter();

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- router lifecycle subscription is an external system
  useEffect(() => {
    let pending: NavigationFocusRequest | null = null;
    let frame: number | null = null;
    let responsiveFrame: number | null = null;
    let lastResponsiveFocus: {
      element: HTMLElement;
      group: string;
    } | null = null;
    let workspaceBreakpointFocus: {
      desktopElement: HTMLElement;
      mobileTrigger: HTMLElement;
    } | null = null;
    let focusRevision = 0;
    const lastDesktopFocus = new Map<string, HTMLElement>();
    const mobileMedia = matchMedia("(max-width: 767px)");

    const cancelFrame = () => {
      if (frame === null) return;
      cancelAnimationFrame(frame);
      frame = null;
    };

    const cancelResponsiveFrame = () => {
      if (responsiveFrame === null) return;
      cancelAnimationFrame(responsiveFrame);
      responsiveFrame = null;
    };

    const rememberResponsiveFocus = (event: FocusEvent) => {
      const element = event.target;
      if (!(element instanceof HTMLElement)) return;
      focusRevision++;
      if (
        workspaceBreakpointFocus &&
        element !== workspaceBreakpointFocus.mobileTrigger
      ) {
        workspaceBreakpointFocus = null;
      }
      const root = element.closest<HTMLElement>(RESPONSIVE_FOCUS_GROUP);
      const group = root?.dataset.responsiveFocusGroup;
      if (!group) {
        lastResponsiveFocus = null;
        return;
      }

      lastResponsiveFocus = { element, group };
      if (!mobileMedia.matches) lastDesktopFocus.set(group, element);
    };

    const clearStaleResponsiveFocus = (event: PointerEvent) => {
      const element = event.target;
      if (
        workspaceBreakpointFocus &&
        (!(element instanceof Node) ||
          !workspaceBreakpointFocus.mobileTrigger.contains(element))
      ) {
        workspaceBreakpointFocus = null;
        focusRevision++;
      }
      if (
        element instanceof HTMLElement &&
        !element.closest(RESPONSIVE_FOCUS_GROUP)
      ) {
        lastResponsiveFocus = null;
      }
    };

    const restoreResponsiveFocus = (event: MediaQueryListEvent) => {
      cancelResponsiveFrame();
      const active = document.activeElement;
      const activeElement = active instanceof HTMLElement ? active : null;
      const workspaceOwner = event.matches
        ? (activeElement?.closest<HTMLElement>(WORKSPACE_PANEL) ?? null)
        : null;
      const workspaceSource =
        event.matches && activeElement && workspaceOwner
          ? { element: activeElement, owner: workspaceOwner }
          : null;
      const workspaceRestore =
        !event.matches &&
        workspaceBreakpointFocus?.mobileTrigger === activeElement
          ? workspaceBreakpointFocus
          : null;
      const revisionAtBreakpoint = focusRevision;
      if (!event.matches) workspaceBreakpointFocus = null;
      const activeRoot = activeElement?.closest<HTMLElement>(
        RESPONSIVE_FOCUS_GROUP,
      );
      const activeGroup = activeRoot?.dataset.responsiveFocusGroup;
      const source =
        activeGroup && activeElement
          ? { element: activeElement, group: activeGroup }
          : !hasUsableFocus()
            ? lastResponsiveFocus
            : null;
      if (!source && !workspaceSource && !workspaceRestore) return;

      responsiveFrame = requestAnimationFrame(() => {
        // `useIsMobile` is an effect-backed media-query subscriber. A second
        // frame observes the committed inert/visibility state instead of
        // guessing which surface the URL will choose from the media event.
        responsiveFrame = requestAnimationFrame(() => {
          responsiveFrame = null;

          if (
            workspaceRestore &&
            focusRevision === revisionAtBreakpoint &&
            !hasUsableFocus() &&
            elementIsVisible(workspaceRestore.desktopElement)
          ) {
            focusRouteTarget(workspaceRestore.desktopElement);
            return;
          }

          // Named responsive counterparts preserve the control's purpose
          // (for example desktop Library search -> mobile Library search).
          // Resolve them before the generic workspace fallback, which only
          // knows that the mobile View trigger is always available.
          if (source && !hasUsableFocus()) {
            const remembered = event.matches
              ? null
              : (lastDesktopFocus.get(source.group) ?? null);
            const target = responsiveFocusTarget(source.group, remembered);
            if (target) {
              focusRouteTarget(target);
              if (hasUsableFocus()) return;
            }
          }

          if (
            workspaceSource &&
            focusRevision === revisionAtBreakpoint &&
            (!elementIsVisible(workspaceSource.owner) ||
              !elementIsVisible(workspaceSource.element)) &&
            !hasUsableFocus()
          ) {
            const mobileTrigger = visibleElement(
              `${MOBILE_VIEW_SELECT_SOURCE}[data-slot="select-trigger"]`,
            );
            if (mobileTrigger) {
              focusRouteTarget(mobileTrigger);
              if (document.activeElement === mobileTrigger) {
                workspaceBreakpointFocus = {
                  desktopElement: workspaceSource.element,
                  mobileTrigger,
                };
                return;
              }
            }
          }
        });
      });
    };

    document.addEventListener("focusin", rememberResponsiveFocus, true);
    document.addEventListener("pointerdown", clearStaleResponsiveFocus, true);
    mobileMedia.addEventListener("change", restoreResponsiveFocus);

    const unsubscribeBeforeNavigate = router.subscribe(
      "onBeforeNavigate",
      (event) => {
        if (!event.hrefChanged) return;
        cancelFrame();

        const source = activeNavigationSource();
        if (source) {
          pending = {
            destinationHref: event.toLocation.href,
            pathChanged: event.pathChanged,
            source: source.element,
            sourceRoot: source.root,
            sourceType: source.type,
            onlyIfFocusLost: false,
          };
          return;
        }

        // Preserve the initiating control across a redirect in the same
        // transition, but never carry a stale request into another navigation.
        const currentRequest = pending;
        if (
          currentRequest &&
          currentRequest.destinationHref === event.fromLocation?.href
        ) {
          pending = {
            ...currentRequest,
            destinationHref: event.toLocation.href,
            pathChanged: currentRequest.pathChanged || event.pathChanged,
          };
        } else {
          // Browser Back/Forward and imperative routing have no activating
          // route control. This includes search-only layout history, whose
          // visible panel toggle can be replaced. Record the transition, but
          // intervene only if the old UI actually takes focus down with it.
          pending = {
            destinationHref: event.toLocation.href,
            pathChanged: event.pathChanged,
            source: null,
            sourceRoot: null,
            sourceType: null,
            onlyIfFocusLost: true,
          };
        }
      },
    );

    const unsubscribeResolved = router.subscribe("onResolved", (event) => {
      const request = pending;
      pending = null;
      if (!request || !event.hrefChanged) return;

      cancelFrame();
      frame = requestAnimationFrame(() => {
        frame = null;
        if (request.onlyIfFocusLost) {
          if (hasUsableFocus()) return;
          const target = request.pathChanged
            ? visibleElement(ROUTE_HEADING)
            : (visibleElement(ROUTE_HEADING) ??
              visibleElement(MAIN_PANEL_CONTROL) ??
              visibleElement(CHAT_PANEL_CONTROL));
          if (target) focusRouteTarget(target);
          return;
        }

        if (!request.source || !request.sourceRoot || !request.sourceType) {
          return;
        }
        const active = document.activeElement;
        const pathChanged = request.pathChanged || event.pathChanged;
        const focusMovedElsewhere =
          hasUsableFocus() &&
          active !== request.source &&
          !(active instanceof Node && request.sourceRoot.contains(active)) &&
          !(pathChanged && focusIsInRouteChrome(active));
        if (focusMovedElsewhere) return;

        const routeTarget = pathChanged
          ? visibleElement(ROUTE_HEADING)
          : request.sourceType === "mobile-view-select"
            ? visibleElement(
                `${MOBILE_VIEW_SELECT_SOURCE}[data-slot="select-trigger"]`,
              )
            : request.sourceType === "main-panel-toggle"
              ? visibleElement(MAIN_PANEL_CONTROL)
              : request.sourceType === "chat-panel-toggle"
                ? visibleElement(CHAT_PANEL_CONTROL)
                : visibleElement(ROUTE_HEADING);
        const target =
          routeTarget ??
          (!pathChanged ? visibleElement(SHOW_MAIN_PANEL_CONTROL) : null);
        if (target) focusRouteTarget(target);
      });
    });

    return () => {
      cancelFrame();
      cancelResponsiveFrame();
      document.removeEventListener("focusin", rememberResponsiveFocus, true);
      document.removeEventListener(
        "pointerdown",
        clearStaleResponsiveFocus,
        true,
      );
      mobileMedia.removeEventListener("change", restoreResponsiveFocus);
      unsubscribeBeforeNavigate();
      unsubscribeResolved();
    };
  }, [router]);

  return null;
}
