import { setupComponentTest } from "../../test/setup";
setupComponentTest();
import { describe, expect, it, mock } from "bun:test";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * The session store has THREE states and this component wraps the whole shell,
 * so each one is pinned here. Two were wrong in turn: with only signed-in and
 * signed-out branches, `isPending` with no data matched neither and painted a
 * blank page; adding better-auth-ui's `<AuthLoading>` as a third SIBLING then
 * let a loader render alongside the app instead of instead of it.
 */
const authState = {
  current: { data: null as unknown, isPending: false },
};
mock.module("@/lib/auth-client", () => ({
  authClient: { useSession: () => authState.current },
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
  navigatedTo.length = 0;
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
    const { getByText, queryByRole } = renderLayout();

    expect(getByText("protected")).toBeInTheDocument();
    // ...and ONLY the app: a loader beside it is the stray-spinner bug.
    expect(queryByRole("status")).toBeNull();
    expect(navigatedTo).toEqual([]);
  });

  it("redirects to /login when settled with no session", () => {
    authState.current = { data: null, isPending: false };
    renderLayout();

    expect(navigatedTo).toEqual(["/login"]);
  });

  it("shows a full-height loader — not a blank page — while pending", () => {
    authState.current = { data: null, isPending: true };
    const { container, getByRole, queryByText } = renderLayout();

    expect(getByRole("status")).toBeInTheDocument();
    // It owns the viewport rather than sitting in a zero-height strip at the
    // top, which is what a panel-shaped loader did in this (non-flex) slot.
    expect(container.firstElementChild).toHaveClass("min-h-dvh");
    expect(queryByText("protected")).toBeNull();
    expect(navigatedTo).toEqual([]);
  });
});
