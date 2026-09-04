import { setupComponentTest } from "../../test/setup";
setupComponentTest();
import { describe, expect, test } from "bun:test";
import { waitFor } from "@testing-library/react";
import {
  focusBelongsToDifferentRoute,
  focusedRouteContentElement,
  NavigationFocusController,
  renderedNavigationMatchesDestination,
  routeHeadingForPathname,
} from "./route-navigation-focus";

interface TestNavigationEvent {
  hrefChanged: boolean;
  pathChanged: boolean;
  fromLocation: { href: string };
  toLocation: { href: string; pathname: string };
}

type TestNavigationEventName = "onBeforeNavigate" | "onRendered";
type TestNavigationHandler = (event: TestNavigationEvent) => void;

function navigationEvent(
  fromHref: string,
  toHref: string,
  options: { hrefChanged?: boolean; pathChanged?: boolean } = {},
): TestNavigationEvent {
  return {
    hrefChanged: options.hrefChanged ?? true,
    pathChanged: options.pathChanged ?? true,
    fromLocation: { href: fromHref },
    toLocation: {
      href: toHref,
      pathname: new URL(toHref, window.location.origin).pathname,
    },
  };
}

function createControllerHarness() {
  const handlers = new Map<TestNavigationEventName, TestNavigationHandler>();
  const router = {
    subscribe(
      eventName: TestNavigationEventName,
      handler: TestNavigationHandler,
    ) {
      handlers.set(eventName, handler);
      return () => handlers.delete(eventName);
    },
  } as unknown as ConstructorParameters<typeof NavigationFocusController>[0];

  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const frames = new Map<number, FrameRequestCallback>();
  const cancelledFrames = new Set<number>();
  let frameId = 0;

  globalThis.requestAnimationFrame = (callback) => {
    const id = ++frameId;
    frames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    cancelledFrames.add(id);
  };

  const controller = new NavigationFocusController(router, document.body);
  const disconnect = controller.connect();

  return {
    emit(eventName: TestNavigationEventName, event: TestNavigationEvent) {
      const handler = handlers.get(eventName);
      if (!handler) throw new Error(`Missing ${eventName} subscriber`);
      handler(event);
    },
    runNextFrame(options: { includeCancelled?: boolean } = {}) {
      const nextFrame = frames.entries().next().value;
      if (!nextFrame) throw new Error("No animation frame was scheduled");
      const [id, callback] = nextFrame;
      frames.delete(id);
      if (!cancelledFrames.has(id) || options.includeCancelled) {
        callback(performance.now());
      }
    },
    cleanup() {
      disconnect();
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
      window.history.replaceState(null, "", "/");
    },
  };
}

function appendRouteHeading(
  pathname: string,
  label: string,
): HTMLHeadingElement {
  let main = document.querySelector<HTMLElement>('[data-slot="main"]');
  if (!main) {
    main = document.createElement("main");
    main.dataset.slot = "main";
    document.body.append(main);
  }

  const heading = document.createElement("h1");
  heading.dataset.routeFocusPathname = pathname;
  heading.textContent = label;
  main.append(heading);
  return heading;
}

describe("route heading focus settlement", () => {
  test("selects only the heading owned by the rendered destination", () => {
    appendRouteHeading("/acme/settings/general", "Settings");
    const destination = appendRouteHeading("/acme/board", "Tasks");

    expect(routeHeadingForPathname("/acme/board")).toBe(destination);
  });

  test("does not mistake an outgoing or differently scoped heading for the destination", () => {
    appendRouteHeading("/first-org/board", "Tasks");

    expect(routeHeadingForPathname("/second-org/board")).toBeNull();
  });

  test("ignores a matching heading while its owning surface is inert", () => {
    const main = document.createElement("main");
    main.dataset.slot = "main";
    main.inert = true;
    document.body.append(main);

    const heading = document.createElement("h1");
    heading.dataset.routeFocusPathname = "/acme/board";
    heading.textContent = "Tasks";
    main.append(heading);

    expect(routeHeadingForPathname("/acme/board")).toBeNull();
  });

  test("recognizes focus still owned by the outgoing route", () => {
    const outgoing = appendRouteHeading("/acme/settings", "Settings");
    outgoing.focus();

    expect(
      focusBelongsToDifferentRoute(document.activeElement, "/acme/board"),
    ).toBe(true);
    expect(
      focusBelongsToDifferentRoute(document.activeElement, "/acme/settings"),
    ).toBe(false);
  });

  test("does not claim persistent focus on behalf of the outgoing route", () => {
    const sidebarLink = document.createElement("a");
    sidebarLink.href = "/acme/board";
    sidebarLink.textContent = "Tasks";
    document.body.append(sidebarLink);
    sidebarLink.focus();

    expect(
      focusBelongsToDifferentRoute(document.activeElement, "/acme/board"),
    ).toBe(false);
  });

  test("records only focus owned by route content", () => {
    const main = document.createElement("main");
    main.dataset.slot = "main";
    const content = document.createElement("div");
    content.dataset.slot = "main-content";
    const routeButton = document.createElement("button");
    const persistentButton = document.createElement("button");
    content.append(routeButton);
    main.append(content, persistentButton);
    document.body.append(main);

    routeButton.focus();
    expect(focusedRouteContentElement(document.activeElement)).toBe(
      routeButton,
    );

    persistentButton.focus();
    expect(focusedRouteContentElement(document.activeElement)).toBeNull();
  });
});

describe("rendered navigation ownership", () => {
  test("accepts an exact cached history destination without a reported href delta", () => {
    expect(
      renderedNavigationMatchesDestination("/acme/board?sidepanel=false", {
        hrefChanged: false,
        pathChanged: false,
        toLocation: {
          href: "/acme/board?sidepanel=false",
          pathname: "/acme/board",
        },
      }),
    ).toBe(true);
  });

  test("rejects a rendered event for a different destination", () => {
    expect(
      renderedNavigationMatchesDestination("/acme/board?sidepanel=false", {
        hrefChanged: true,
        pathChanged: true,
        toLocation: {
          href: "/acme/settings/general",
          pathname: "/acme/settings/general",
        },
      }),
    ).toBe(false);
  });
});

describe("navigation focus controller", () => {
  test("external autofocus between render and frame cancels the route handoff", () => {
    const harness = createControllerHarness();
    try {
      window.history.replaceState(null, "", "/acme/settings");
      const source = document.createElement("button");
      source.dataset.routeFocusSource = "route";
      document.body.append(source);
      source.focus();

      harness.emit(
        "onBeforeNavigate",
        navigationEvent("/acme/settings", "/acme/board"),
      );
      window.history.replaceState(null, "", "/acme/board");
      const destination = appendRouteHeading("/acme/board", "Tasks");
      harness.emit(
        "onRendered",
        navigationEvent("/acme/settings", "/acme/board"),
      );

      const autofocusTarget = document.createElement("input");
      document.body.append(autofocusTarget);
      autofocusTarget.focus();
      harness.runNextFrame({ includeCancelled: true });

      expect(autofocusTarget).toHaveFocus();
      expect(destination).not.toHaveFocus();
    } finally {
      harness.cleanup();
    }
  });

  test("a controller-owned heading focus can settle without self-cancelling", () => {
    const harness = createControllerHarness();
    try {
      window.history.replaceState(null, "", "/acme/settings");
      const source = document.createElement("button");
      source.dataset.routeFocusSource = "route";
      document.body.append(source);
      source.focus();

      harness.emit(
        "onBeforeNavigate",
        navigationEvent("/acme/settings", "/acme/board"),
      );
      window.history.replaceState(null, "", "/acme/board");
      const destination = appendRouteHeading("/acme/board", "Tasks");
      harness.emit(
        "onRendered",
        navigationEvent("/acme/settings", "/acme/board"),
      );
      harness.runNextFrame();

      expect(destination).toHaveFocus();
    } finally {
      harness.cleanup();
    }
  });

  test("history replaces an outgoing route-content control with the exact destination heading", async () => {
    const harness = createControllerHarness();
    try {
      window.history.replaceState(null, "", "/acme/settings");
      const main = document.createElement("main");
      main.dataset.slot = "main";
      const content = document.createElement("div");
      content.dataset.slot = "main-content";
      const outgoingControl = document.createElement("button");
      content.append(outgoingControl);
      main.append(content);
      document.body.append(main);
      outgoingControl.focus();

      harness.emit(
        "onBeforeNavigate",
        navigationEvent("/acme/settings", "/acme/board"),
      );
      window.history.replaceState(null, "", "/acme/board");
      harness.emit(
        "onRendered",
        navigationEvent("/acme/board", "/acme/board", {
          hrefChanged: false,
          pathChanged: false,
        }),
      );
      harness.runNextFrame();

      content.remove();
      const destination = appendRouteHeading("/acme/board", "Tasks");
      await waitFor(() => expect(destination).toHaveFocus());
    } finally {
      harness.cleanup();
    }
  });
});
