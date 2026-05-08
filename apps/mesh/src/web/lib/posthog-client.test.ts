import { describe, expect, test, beforeEach, afterAll, mock } from "bun:test";

type GroupCall = [type: string, key: string, props: unknown];

const groupCalls: GroupCall[] = [];
const initCalls: unknown[][] = [];
let resetCount = 0;

// `initPostHog` early-returns when `typeof window === "undefined"`. Bun's test
// runtime has no DOM, so stub a minimal window before importing the module.
// Track whether we own the stub so we can clean it up afterAll — leaving a
// fake `window` on globalThis breaks other tests that check `typeof window`
// and then dereference its DOM properties (e.g. PGlite's `window.location`).
const windowStubbedHere = typeof globalThis.window === "undefined";
if (windowStubbedHere) {
  (globalThis as unknown as { window: object }).window = {};
}

afterAll(() => {
  if (windowStubbedHere) {
    delete (globalThis as { window?: unknown }).window;
  }
});

mock.module("posthog-js", () => ({
  default: {
    init: (...args: unknown[]) => {
      initCalls.push(args);
    },
    group: (type: string, key: string, props: unknown) => {
      groupCalls.push([type, key, props]);
    },
    reset: () => {
      resetCount += 1;
    },
    identify: () => {},
    capture: () => {},
    captureException: () => {},
  },
}));

const { initPostHog, setOrganizationGroup, resetUser, __resetForTest } =
  await import("./posthog-client");

describe("posthog-client.setOrganizationGroup", () => {
  beforeEach(() => {
    groupCalls.length = 0;
    initCalls.length = 0;
    resetCount = 0;
    __resetForTest();
  });

  test("is a no-op before initPostHog is called", () => {
    setOrganizationGroup("org_1", { name: "Acme", slug: "acme" });
    expect(groupCalls).toHaveLength(0);
  });

  test("calls posthog.group with organization type after init", () => {
    initPostHog("phc_test", "https://us.i.posthog.com");
    setOrganizationGroup("org_1", { name: "Acme", slug: "acme" });
    expect(groupCalls).toEqual([
      ["organization", "org_1", { name: "Acme", slug: "acme" }],
    ]);
  });

  test("de-dupes consecutive calls with the same orgId", () => {
    initPostHog("phc_test", "https://us.i.posthog.com");
    setOrganizationGroup("org_1", { name: "Acme", slug: "acme" });
    setOrganizationGroup("org_1", { name: "Acme", slug: "acme" });
    expect(groupCalls).toHaveLength(1);
  });

  test("fires again when orgId changes", () => {
    initPostHog("phc_test", "https://us.i.posthog.com");
    setOrganizationGroup("org_1", { name: "Acme", slug: "acme" });
    setOrganizationGroup("org_2", { name: "Beta", slug: "beta" });
    expect(groupCalls).toHaveLength(2);
    expect(groupCalls[1]).toEqual([
      "organization",
      "org_2",
      { name: "Beta", slug: "beta" },
    ]);
  });

  test("resetUser clears the cached org so the next setOrganizationGroup re-fires", () => {
    initPostHog("phc_test", "https://us.i.posthog.com");
    setOrganizationGroup("org_1", { name: "Acme", slug: "acme" });
    resetUser();
    expect(resetCount).toBe(1);

    setOrganizationGroup("org_1", { name: "Acme", slug: "acme" });
    expect(groupCalls).toHaveLength(2);
  });
});
