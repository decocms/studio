import { afterAll, beforeEach, describe, expect, test } from "bun:test";

// `defaultAuthFormActions` pulls in `@/lib/auth-client` (better-auth/react),
// which only touches `window` lazily — but `onAuthenticated` itself reads
// `window.location` synchronously, so stub a minimal window like
// `posthog-client.test.ts` does.
const windowStubbedHere = typeof globalThis.window === "undefined";
if (windowStubbedHere) {
  (globalThis as unknown as { window: object }).window = {};
}

afterAll(() => {
  if (windowStubbedHere) {
    delete (globalThis as { window?: unknown }).window;
  }
});

const { defaultAuthFormActions } = await import("./auth-form-actions");

function stubLocation(href: string) {
  const reloadCalls: unknown[] = [];
  (window as unknown as { location: unknown }).location = {
    href,
    reload: (...args: unknown[]) => reloadCalls.push(args),
  };
  return reloadCalls;
}

describe("defaultAuthFormActions.onAuthenticated", () => {
  beforeEach(() => {
    stubLocation(
      "https://studio.decocms.com/report/example.com?share_id=abc#categorias",
    );
  });

  test("reloads instead of a no-op assignment when redirectTo matches the current URL", () => {
    const current = window.location.href;
    const reloadCalls = stubLocation(current);
    defaultAuthFormActions.onAuthenticated(current);
    expect(reloadCalls.length).toBe(1);
    // href is untouched — reload() is what actually re-fetches the page.
    expect(window.location.href).toBe(current);
  });

  test("navigates via location.href when redirectTo differs from the current URL", () => {
    defaultAuthFormActions.onAuthenticated("/organization/acme");
    expect(window.location.href).toBe("/organization/acme");
  });
});
