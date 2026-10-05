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

const identifyCalls: unknown[][] = [];
const aliasCalls: unknown[][] = [];

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
    identify: (...args: unknown[]) => {
      identifyCalls.push(args);
    },
    alias: (...args: unknown[]) => {
      aliasCalls.push(args);
    },
    capture: () => {},
    captureException: () => {},
  },
}));

const {
  initPostHog,
  identifyUser,
  sanitizeAnalyticsUrl,
  setOrganizationGroup,
  resetUser,
  __resetForTest,
} = await import("./posthog-client");

/** Minimal localStorage stub — enough for the LP-stash read/write/remove. */
function stubLocalStorage(seed: Record<string, string> = {}) {
  const store: Record<string, string> = { ...seed };
  const stub = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
  };
  (globalThis.window as { localStorage?: unknown }).localStorage = stub;
  return store;
}

describe("posthog-client report URL privacy", () => {
  beforeEach(() => {
    initCalls.length = 0;
    __resetForTest();
  });

  test("removes report credentials while preserving attribution", () => {
    expect(
      sanitizeAnalyticsUrl(
        "https://studio.decocms.com/report/acme.com?key=preview&d=email-token&share_id=share-1&utm_source=email#overview",
      ),
    ).toBe(
      "https://studio.decocms.com/report/acme.com?share_id=share-1&utm_source=email#overview",
    );
    expect(
      sanitizeAnalyticsUrl(
        "/api/_reports/site/acme.com?key=preview&share_id=share-1",
      ),
    ).toBe("/api/_reports/site/acme.com?share_id=share-1");
  });

  test("redacts email link tokens embedded in API paths", () => {
    expect(
      sanitizeAnalyticsUrl(
        "/api/_reports/link-token/private-token?email_run_id=run-42",
      ),
    ).toBe("/api/_reports/link-token/redacted?email_run_id=run-42");
  });

  test("leaves ordinary URLs and non-URL values unchanged", () => {
    expect(sanitizeAnalyticsUrl("https://studio.decocms.com/acme/tasks")).toBe(
      "https://studio.decocms.com/acme/tasks",
    );
    expect(sanitizeAnalyticsUrl("not a URL")).toBe("not a URL");
  });

  test("applies the sanitizer to events and session replay URLs", () => {
    initPostHog("phc_test", "https://us.i.posthog.com");
    const config = initCalls[0]?.[1] as {
      before_send: (event: {
        properties: Record<string, unknown>;
        $set_once?: Record<string, unknown>;
      }) => {
        properties: Record<string, unknown>;
        $set_once?: Record<string, unknown>;
      };
      session_recording: {
        maskCapturedNetworkRequestFn: (request: { name: string }) => {
          name: string;
        };
      };
    };

    const event = config.before_send({
      properties: {
        $current_url:
          "https://studio.decocms.com/report/acme.com?key=preview&utm_source=share",
      },
      $set_once: {
        $initial_current_url:
          "https://studio.decocms.com/report/acme.com?d=email-token&utm_source=email",
      },
    });
    expect(event.properties.$current_url).toBe(
      "https://studio.decocms.com/report/acme.com?utm_source=share",
    );
    expect(event.$set_once?.$initial_current_url).toBe(
      "https://studio.decocms.com/report/acme.com?utm_source=email",
    );

    expect(
      config.session_recording.maskCapturedNetworkRequestFn({
        name: "/api/_reports/site/acme.com?key=preview",
      }),
    ).toEqual({
      name: "/api/_reports/site/acme.com",
    });
    expect(
      config.session_recording.maskCapturedNetworkRequestFn({
        name: "/api/_reports/link-token/email-token",
      }),
    ).toEqual({ name: "/api/_reports/link-token/redacted" });
  });
});

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

describe("posthog-client.identifyUser LP merge", () => {
  beforeEach(() => {
    identifyCalls.length = 0;
    aliasCalls.length = 0;
    __resetForTest();
    delete (globalThis.window as { localStorage?: unknown }).localStorage;
  });

  test("aliases the stashed LP distinct_id after identify, then clears it", () => {
    const store = stubLocalStorage({
      "mesh:lp-distinct-id": JSON.stringify({
        id: "lp-anon-1",
        ts: Date.now(),
      }),
    });
    initPostHog("phc_test", "https://us.i.posthog.com");
    identifyUser("user_42", { email: "x@y.com" });
    expect(identifyCalls).toHaveLength(1);
    expect(aliasCalls).toEqual([["lp-anon-1"]]);
    expect(store["mesh:lp-distinct-id"]).toBeUndefined(); // one-shot
  });

  test("second login does not re-alias (stash consumed)", () => {
    stubLocalStorage({
      "mesh:lp-distinct-id": JSON.stringify({
        id: "lp-anon-1",
        ts: Date.now(),
      }),
    });
    initPostHog("phc_test", "https://us.i.posthog.com");
    identifyUser("user_42");
    identifyUser("user_42");
    expect(aliasCalls).toHaveLength(1);
  });

  test("ignores an expired stash", () => {
    stubLocalStorage({
      "mesh:lp-distinct-id": JSON.stringify({
        id: "lp-anon-1",
        ts: Date.now() - 25 * 60 * 60 * 1000,
      }),
    });
    initPostHog("phc_test", "https://us.i.posthog.com");
    identifyUser("user_42");
    expect(aliasCalls).toHaveLength(0);
  });

  test("ignores a corrupt stash and no localStorage at all", () => {
    stubLocalStorage({ "mesh:lp-distinct-id": "not-json" });
    initPostHog("phc_test", "https://us.i.posthog.com");
    identifyUser("user_42");
    expect(aliasCalls).toHaveLength(0);

    __resetForTest();
    delete (globalThis.window as { localStorage?: unknown }).localStorage;
    initPostHog("phc_test", "https://us.i.posthog.com");
    identifyUser("user_42");
    expect(aliasCalls).toHaveLength(0);
  });
});
