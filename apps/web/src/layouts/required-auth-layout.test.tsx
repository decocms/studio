import { setupComponentTest } from "../../test/setup";
setupComponentTest();
import { describe, expect, it, mock } from "bun:test";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * better-auth's session store has THREE states, and the third used to render
 * nothing at all: `SignedIn` needs data, `SignedOut` needs no-data AND settled,
 * so `isPending` with no data fell between them and blanked the page. That is
 * not a boot-only state — better-auth sets it on any post-boot refetch of a
 * session it does not have, including the one fired right after `signOut()`.
 *
 * The three components are stubbed with better-auth-ui's own conditions
 * (`dist/index.js`: SignedIn renders `if (data)`, SignedOut `if (!data &&
 * !isPending)`, AuthLoading `if (isPending)`), so the test asserts OUR
 * branching rather than re-testing the library.
 */
const authState = {
  current: { data: null as unknown, isPending: false },
};
mock.module("@daveyplate/better-auth-ui", () => ({
  SignedIn: ({ children }: { children: ReactNode }) =>
    authState.current.data ? children : null,
  SignedOut: ({ children }: { children: ReactNode }) =>
    !authState.current.data && !authState.current.isPending ? children : null,
  AuthLoading: ({ children }: { children: ReactNode }) =>
    authState.current.isPending ? children : null,
}));

const navigatedTo: string[] = [];
mock.module("@tanstack/react-router", () => ({
  Navigate: ({ to }: { to: string }) => {
    navigatedTo.push(to);
    return null;
  },
}));

const { default: RequiredAuthLayout } = await import("./required-auth-layout");

function renderLayout() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <RequiredAuthLayout>
        <p>protected</p>
      </RequiredAuthLayout>
    </QueryClientProvider>,
  );
}

describe("RequiredAuthLayout", () => {
  it("renders the app when the session is present", () => {
    authState.current = { data: { user: { id: "u1" } }, isPending: false };
    const { getByText } = renderLayout();
    expect(getByText("protected")).toBeInTheDocument();
  });

  it("redirects to /login when settled with no session", () => {
    authState.current = { data: null, isPending: false };
    navigatedTo.length = 0;
    renderLayout();
    expect(navigatedTo).toEqual(["/login"]);
  });

  /** The regression: neither branch matched, so the whole app went white. */
  it("shows a loader — not a blank page — while a session refetch is pending", () => {
    authState.current = { data: null, isPending: true };
    navigatedTo.length = 0;
    const { container, getByRole } = renderLayout();

    expect(getByRole("status")).toBeInTheDocument();
    expect(container).not.toBeEmptyDOMElement();
    // ...and it must not bounce the user to /login on a state that is not "out".
    expect(navigatedTo).toEqual([]);
  });
});
