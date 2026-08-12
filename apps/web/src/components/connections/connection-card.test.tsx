import { setupComponentTest } from "../../../test/setup"; // happy-dom + jest-dom matchers
setupComponentTest();
import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render as renderBare } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ConnectionCard } from "./connection-card";

// useT() reads its language preference through TanStack Query.
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const render = (ui: Parameters<typeof renderBare>[0]) =>
  renderBare(ui, { wrapper });

describe("ConnectionCard", () => {
  it("activates onClick when Enter is pressed on the card itself", () => {
    const onClick = mock();
    const { getByRole } = render(
      <ConnectionCard connection={{ title: "Foo" }} onClick={onClick} />,
    );
    fireEvent.keyDown(getByRole("button"), { key: "Enter" });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not activate onClick when Enter is pressed on a nested header action", () => {
    const onClick = mock();
    const onAction = mock();
    const { getByTestId } = render(
      <ConnectionCard
        connection={{ title: "Foo" }}
        onClick={onClick}
        headerActions={
          <button type="button" data-testid="action" onClick={onAction}>
            Manage
          </button>
        }
      />,
    );
    fireEvent.keyDown(getByTestId("action"), { key: "Enter" });
    expect(onClick).not.toHaveBeenCalled();
  });
});
