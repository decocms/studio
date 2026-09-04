import { type RefCallback, useState } from "react";
import { useRouter } from "@tanstack/react-router";

type NavigationFocusSource =
  | "chat-panel-toggle"
  | "main-panel-toggle"
  | "mobile-view-select"
  | "route";

interface NavigationFocusRequest {
  destinationHref: string;
  destinationPathname: string;
  interactionRevision: number;
  outgoingRouteFocus: HTMLElement | null;
  pathChanged: boolean;
  source: HTMLElement | null;
  sourceRoot: HTMLElement | null;
  sourceType: NavigationFocusSource | null;
  onlyIfFocusLost: boolean;
}

interface BeforeNavigateEvent {
  hrefChanged: boolean;
  pathChanged: boolean;
  toLocation: { href: string; pathname: string };
  fromLocation?: { href: string };
}

interface RenderedEvent {
  hrefChanged: boolean;
  pathChanged: boolean;
  toLocation: { href: string; pathname: string };
}

type NavigationRouter = ReturnType<typeof useRouter>;

const MOBILE_VIEW_SELECT_SOURCE =
  '[data-route-focus-source="mobile-view-select"]';
const ROUTE_CONTROL_SOURCE = '[data-route-focus-source="route"]';
const ROUTE_HEADING = '[data-testid="main-panel"] h1, [data-slot="main"] h1';
const MAIN_PANEL_CONTROL = '[aria-controls="workspace-main-panel"]';
const CHAT_PANEL_CONTROL = '[aria-controls="workspace-side-panel"]';
const SHOW_MAIN_PANEL_CONTROL = `${MAIN_PANEL_CONTROL}[aria-expanded="false"]`;
const RESPONSIVE_FOCUS_GROUP = "[data-responsive-focus-group]";
const ROUTE_CONTENT = '[data-slot="main-content"]';
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

export function routeHeadingForPathname(pathname: string): HTMLElement | null {
  for (const heading of document.querySelectorAll<HTMLElement>(ROUTE_HEADING)) {
    if (
      elementIsVisible(heading) &&
      heading.dataset.routeFocusPathname === pathname
    ) {
      return heading;
    }
  }
  return null;
}

export function renderedNavigationMatchesDestination(
  destinationHref: string,
  event: RenderedEvent,
): boolean {
  // TanStack can emit `hrefChanged: false` when Back/Forward resolves a cached
  // location. The exact pending href, not this advisory delta, owns settlement.
  return destinationHref === event.toLocation.href;
}

export function focusBelongsToDifferentRoute(
  active: Element | null,
  destinationPathname: string,
): boolean {
  if (!(active instanceof HTMLElement) || !elementIsVisible(active)) {
    return false;
  }

  const routeOwner = active.closest<HTMLElement>("[data-route-focus-pathname]");
  const focusedPathname = routeOwner?.dataset.routeFocusPathname;
  return Boolean(focusedPathname && focusedPathname !== destinationPathname);
}

export function focusedRouteContentElement(
  active: Element | null,
): HTMLElement | null {
  if (
    !(active instanceof HTMLElement) ||
    !elementIsVisible(active) ||
    !active.closest(ROUTE_CONTENT)
  ) {
    return null;
  }
  return active;
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

function focusRouteTarget(target: HTMLElement): boolean {
  const needsTemporaryTabIndex =
    !target.matches(RESPONSIVE_FOCUSABLE) && !target.hasAttribute("tabindex");
  if (needsTemporaryTabIndex) target.setAttribute("tabindex", "-1");

  target.focus({ preventScroll: true });

  if (needsTemporaryTabIndex) {
    if (document.activeElement !== target) {
      target.removeAttribute("tabindex");
      return false;
    }
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

  return document.activeElement === target;
}

/**
 * Owns the imperative browser and router lifecycle used for focus handoff.
 * A React 19 ref callback mounts this controller and runs its returned cleanup,
 * so subscriptions follow the rendered shell without an effect-backed mirror.
 */
export class NavigationFocusController {
  private static readonly ROUTE_HEADING_TIMEOUT_MS = 10_000;
  private pending: NavigationFocusRequest | null = null;
  private frame: number | null = null;
  private responsiveFrame: number | null = null;
  private routeHeadingObserver: MutationObserver | null = null;
  private routeHeadingTimeout: number | null = null;
  private controllerFocusTarget: HTMLElement | null = null;
  private navigationInteractionRevision = 0;
  private lastResponsiveFocus: {
    element: HTMLElement;
    group: string;
  } | null = null;
  private workspaceBreakpointFocus: {
    desktopElement: HTMLElement;
    mobileTrigger: HTMLElement;
  } | null = null;
  private focusRevision = 0;
  private readonly lastDesktopFocus = new Map<string, HTMLElement>();
  private readonly mobileMedia = matchMedia("(max-width: 767px)");

  constructor(
    private readonly router: NavigationRouter,
    private readonly routeObservationRoot: HTMLElement,
  ) {}

  connect(): () => void {
    document.addEventListener("focusin", this.rememberResponsiveFocus, true);
    document.addEventListener(
      "pointerdown",
      this.clearStaleResponsiveFocus,
      true,
    );
    document.addEventListener(
      "keydown",
      this.cancelRouteHeadingOnKeyboard,
      true,
    );
    this.mobileMedia.addEventListener("change", this.restoreResponsiveFocus);

    const unsubscribeBeforeNavigate = this.router.subscribe(
      "onBeforeNavigate",
      (event) => this.handleBeforeNavigate(event),
    );
    const unsubscribeRendered = this.router.subscribe("onRendered", (event) =>
      this.handleRendered(event),
    );

    return () => {
      this.cancelFrame();
      this.cancelResponsiveFrame();
      this.cancelRouteHeadingWait();
      document.removeEventListener(
        "focusin",
        this.rememberResponsiveFocus,
        true,
      );
      document.removeEventListener(
        "pointerdown",
        this.clearStaleResponsiveFocus,
        true,
      );
      document.removeEventListener(
        "keydown",
        this.cancelRouteHeadingOnKeyboard,
        true,
      );
      this.mobileMedia.removeEventListener(
        "change",
        this.restoreResponsiveFocus,
      );
      unsubscribeBeforeNavigate();
      unsubscribeRendered();
    };
  }

  private cancelFrame(): void {
    if (this.frame === null) return;
    cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  private cancelResponsiveFrame(): void {
    if (this.responsiveFrame === null) return;
    cancelAnimationFrame(this.responsiveFrame);
    this.responsiveFrame = null;
  }

  private cancelRouteHeadingWait(): void {
    this.routeHeadingObserver?.disconnect();
    this.routeHeadingObserver = null;
    if (this.routeHeadingTimeout !== null) {
      window.clearTimeout(this.routeHeadingTimeout);
      this.routeHeadingTimeout = null;
    }
  }

  private focusTarget(target: HTMLElement): boolean {
    this.controllerFocusTarget = target;
    try {
      return focusRouteTarget(target);
    } finally {
      this.controllerFocusTarget = null;
    }
  }

  private focusRouteHeading(request: NavigationFocusRequest): void {
    this.cancelRouteHeadingWait();

    const focusIfReady = () => {
      if (
        this.navigationInteractionRevision !== request.interactionRevision ||
        window.location.pathname !== request.destinationPathname
      ) {
        this.cancelRouteHeadingWait();
        return;
      }

      const target = routeHeadingForPathname(request.destinationPathname);
      if (target && this.focusTarget(target)) this.cancelRouteHeadingWait();
    };

    const observationRoot = this.routeObservationRoot.isConnected
      ? this.routeObservationRoot
      : document.getElementById("root");
    if (!observationRoot) return;

    this.routeHeadingObserver = new MutationObserver(focusIfReady);
    this.routeHeadingObserver.observe(observationRoot, {
      attributeFilter: [
        "aria-hidden",
        "class",
        "data-route-focus-pathname",
        "hidden",
        "inert",
        "style",
      ],
      attributes: true,
      childList: true,
      subtree: true,
    });
    this.routeHeadingTimeout = window.setTimeout(
      () => this.cancelRouteHeadingWait(),
      NavigationFocusController.ROUTE_HEADING_TIMEOUT_MS,
    );
    focusIfReady();
  }

  private readonly rememberResponsiveFocus = (event: FocusEvent): void => {
    const element = event.target;
    if (!(element instanceof HTMLElement)) return;

    // Native `focusin` is synchronous with `focus()`, so a controller-owned
    // target can settle without invalidating itself. Any other component that
    // deliberately claims focus owns the handoff, including autofocus between
    // `onRendered` and the next animation frame.
    if (
      element !== this.controllerFocusTarget &&
      (this.pending || this.frame !== null || this.routeHeadingObserver)
    ) {
      this.navigationInteractionRevision++;
      this.pending = null;
      this.cancelFrame();
      this.cancelRouteHeadingWait();
    }

    this.focusRevision++;
    if (
      this.workspaceBreakpointFocus &&
      element !== this.workspaceBreakpointFocus.mobileTrigger
    ) {
      this.workspaceBreakpointFocus = null;
    }

    const root = element.closest<HTMLElement>(RESPONSIVE_FOCUS_GROUP);
    const group = root?.dataset.responsiveFocusGroup;
    if (!group) {
      this.lastResponsiveFocus = null;
      return;
    }

    this.lastResponsiveFocus = { element, group };
    if (!this.mobileMedia.matches) {
      this.lastDesktopFocus.set(group, element);
    }
  };

  private readonly clearStaleResponsiveFocus = (event: PointerEvent): void => {
    const element = event.target;
    this.navigationInteractionRevision++;
    this.cancelFrame();
    this.cancelRouteHeadingWait();
    if (
      this.workspaceBreakpointFocus &&
      (!(element instanceof Node) ||
        !this.workspaceBreakpointFocus.mobileTrigger.contains(element))
    ) {
      this.workspaceBreakpointFocus = null;
      this.focusRevision++;
    }
    if (
      element instanceof HTMLElement &&
      !element.closest(RESPONSIVE_FOCUS_GROUP)
    ) {
      this.lastResponsiveFocus = null;
    }
  };

  private readonly cancelRouteHeadingOnKeyboard = (): void => {
    this.navigationInteractionRevision++;
    this.cancelFrame();
    this.cancelRouteHeadingWait();
  };

  private readonly restoreResponsiveFocus = (
    event: MediaQueryListEvent,
  ): void => {
    this.cancelResponsiveFrame();
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
      this.workspaceBreakpointFocus?.mobileTrigger === activeElement
        ? this.workspaceBreakpointFocus
        : null;
    const revisionAtBreakpoint = this.focusRevision;
    if (!event.matches) this.workspaceBreakpointFocus = null;

    const activeRoot = activeElement?.closest<HTMLElement>(
      RESPONSIVE_FOCUS_GROUP,
    );
    const activeGroup = activeRoot?.dataset.responsiveFocusGroup;
    const source =
      activeGroup && activeElement
        ? { element: activeElement, group: activeGroup }
        : !hasUsableFocus()
          ? this.lastResponsiveFocus
          : null;
    if (!source && !workspaceSource && !workspaceRestore) return;

    this.responsiveFrame = requestAnimationFrame(() => {
      // `useIsMobile` is an effect-backed media-query subscriber. A second
      // frame observes the committed inert/visibility state instead of
      // guessing which surface the URL will choose from the media event.
      this.responsiveFrame = requestAnimationFrame(() => {
        this.responsiveFrame = null;

        if (
          workspaceRestore &&
          this.focusRevision === revisionAtBreakpoint &&
          !hasUsableFocus() &&
          elementIsVisible(workspaceRestore.desktopElement)
        ) {
          this.focusTarget(workspaceRestore.desktopElement);
          return;
        }

        // Named responsive counterparts preserve the control's purpose
        // (for example desktop Library search -> mobile Library search).
        // Resolve them before the generic workspace fallback, which only
        // knows that the mobile View trigger is always available.
        if (source && !hasUsableFocus()) {
          const remembered = event.matches
            ? null
            : (this.lastDesktopFocus.get(source.group) ?? null);
          const target = responsiveFocusTarget(source.group, remembered);
          if (target) {
            this.focusTarget(target);
            if (hasUsableFocus()) return;
          }
        }

        if (
          workspaceSource &&
          this.focusRevision === revisionAtBreakpoint &&
          (!elementIsVisible(workspaceSource.owner) ||
            !elementIsVisible(workspaceSource.element)) &&
          !hasUsableFocus()
        ) {
          const mobileTrigger = visibleElement(
            `${MOBILE_VIEW_SELECT_SOURCE}[data-slot="select-trigger"]`,
          );
          if (mobileTrigger) {
            this.focusTarget(mobileTrigger);
            if (document.activeElement === mobileTrigger) {
              this.workspaceBreakpointFocus = {
                desktopElement: workspaceSource.element,
                mobileTrigger,
              };
            }
          }
        }
      });
    });
  };

  private handleBeforeNavigate(event: BeforeNavigateEvent): void {
    if (!event.hrefChanged) return;
    this.cancelFrame();
    this.cancelRouteHeadingWait();

    const source = activeNavigationSource();
    if (source) {
      this.pending = {
        destinationHref: event.toLocation.href,
        destinationPathname: event.toLocation.pathname,
        interactionRevision: this.navigationInteractionRevision,
        outgoingRouteFocus: null,
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
    const currentRequest = this.pending;
    if (
      currentRequest &&
      currentRequest.destinationHref === event.fromLocation?.href
    ) {
      this.pending = {
        ...currentRequest,
        destinationHref: event.toLocation.href,
        destinationPathname: event.toLocation.pathname,
        pathChanged: currentRequest.pathChanged || event.pathChanged,
      };
      return;
    }

    // Browser Back/Forward and imperative routing have no activating route
    // control. Search-only history may also replace the visible panel toggle.
    // Intervene only if the old UI actually takes focus down with it.
    this.pending = {
      destinationHref: event.toLocation.href,
      destinationPathname: event.toLocation.pathname,
      interactionRevision: this.navigationInteractionRevision,
      outgoingRouteFocus: focusedRouteContentElement(document.activeElement),
      pathChanged: event.pathChanged,
      source: null,
      sourceRoot: null,
      sourceType: null,
      onlyIfFocusLost: true,
    };
  }

  private handleRendered(event: RenderedEvent): void {
    const request = this.pending;
    if (
      !request ||
      !renderedNavigationMatchesDestination(request.destinationHref, event)
    ) {
      return;
    }
    this.pending = null;

    this.cancelFrame();
    this.cancelRouteHeadingWait();
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (
        this.navigationInteractionRevision !== request.interactionRevision ||
        window.location.pathname !== request.destinationPathname
      ) {
        return;
      }
      const pathChanged = request.pathChanged || event.pathChanged;
      if (request.onlyIfFocusLost) {
        if (pathChanged) {
          // TanStack's rendered event can precede removal of the outgoing
          // route. During browser Back/Forward, its focused heading is still
          // usable for this frame but is about to disappear. Keep a bounded
          // destination-specific observer alive instead of mistaking that
          // transient focus for a completed handoff.
          if (
            hasUsableFocus() &&
            document.activeElement !== request.outgoingRouteFocus &&
            !focusBelongsToDifferentRoute(
              document.activeElement,
              request.destinationPathname,
            )
          ) {
            return;
          }
          this.focusRouteHeading(request);
          return;
        }
        if (hasUsableFocus()) return;
        const target =
          visibleElement(ROUTE_HEADING) ??
          visibleElement(MAIN_PANEL_CONTROL) ??
          visibleElement(CHAT_PANEL_CONTROL);
        if (target) this.focusTarget(target);
        return;
      }

      if (!request.source || !request.sourceRoot || !request.sourceType) return;

      if (pathChanged) {
        this.focusRouteHeading(request);
        return;
      }

      const active = document.activeElement;
      const focusMovedElsewhere =
        hasUsableFocus() &&
        active !== request.source &&
        !(active instanceof Node && request.sourceRoot.contains(active)) &&
        !focusIsInRouteChrome(active);
      if (focusMovedElsewhere) return;

      const routeTarget =
        request.sourceType === "mobile-view-select"
          ? visibleElement(
              `${MOBILE_VIEW_SELECT_SOURCE}[data-slot="select-trigger"]`,
            )
          : request.sourceType === "main-panel-toggle"
            ? visibleElement(MAIN_PANEL_CONTROL)
            : request.sourceType === "chat-panel-toggle"
              ? visibleElement(CHAT_PANEL_CONTROL)
              : visibleElement(ROUTE_HEADING);
      const target = routeTarget ?? visibleElement(SHOW_MAIN_PANEL_CONTROL);
      if (target) this.focusTarget(target);
    });
  }
}

function createNavigationFocusRef(
  router: NavigationRouter,
): RefCallback<HTMLSpanElement> {
  return (node) => {
    if (!node) return;
    return new NavigationFocusController(
      router,
      node.parentElement ?? node.ownerDocument.body,
    ).connect();
  };
}

/**
 * Restores a meaningful focus position after route-owned controls replace
 * themselves. Persistent navigation keeps its focus; dialogs and other
 * components may perform their own handoff. We intervene only when focus was
 * still owned by the activating control (or was lost with it).
 */
export function RouteNavigationFocus() {
  const router = useRouter();
  const [mount] = useState<RefCallback<HTMLSpanElement>>(() =>
    createNavigationFocusRef(router),
  );

  return <span ref={mount} hidden data-slot="route-navigation-focus" />;
}
