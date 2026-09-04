import { setupComponentTest } from "../../test/setup";
setupComponentTest();

import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "bun:test";
import { useState, type ReactNode } from "react";
import { ErrorBoundary } from "./error-boundary";

function BoundaryHarness({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false } },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function StatefulChild() {
  const [count, setCount] = useState(0);
  return (
    <button type="button" onClick={() => setCount((value) => value + 1)}>
      Count: {count}
    </button>
  );
}

function MaybeThrows({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error("expected boundary test error");
  return <div>Healthy route</div>;
}

function withExpectedErrorLogs<T>(run: () => T): T {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    return run();
  } finally {
    console.error = originalConsoleError;
  }
}

describe("ErrorBoundary resetKey", () => {
  it("preserves healthy descendant state when the reset key changes", () => {
    const view = render(
      <BoundaryHarness>
        <ErrorBoundary resetKey="list">
          <StatefulChild />
        </ErrorBoundary>
      </BoundaryHarness>,
    );

    fireEvent.click(view.getByRole("button", { name: "Count: 0" }));
    expect(view.getByRole("button", { name: "Count: 1" })).toBeInTheDocument();

    view.rerender(
      <BoundaryHarness>
        <ErrorBoundary resetKey="detail">
          <StatefulChild />
        </ErrorBoundary>
      </BoundaryHarness>,
    );

    expect(view.getByRole("button", { name: "Count: 1" })).toBeInTheDocument();
  });

  it("keeps the fallback until an errored boundary receives a new reset key", () => {
    withExpectedErrorLogs(() => {
      const view = render(
        <BoundaryHarness>
          <ErrorBoundary resetKey="broken" fallback={<div>Route error</div>}>
            <MaybeThrows shouldThrow />
          </ErrorBoundary>
        </BoundaryHarness>,
      );

      view.rerender(
        <BoundaryHarness>
          <ErrorBoundary resetKey="broken" fallback={<div>Route error</div>}>
            <MaybeThrows shouldThrow={false} />
          </ErrorBoundary>
        </BoundaryHarness>,
      );
      expect(view.getByText("Route error")).toBeInTheDocument();

      view.rerender(
        <BoundaryHarness>
          <ErrorBoundary resetKey="healthy" fallback={<div>Route error</div>}>
            <MaybeThrows shouldThrow={false} />
          </ErrorBoundary>
        </BoundaryHarness>,
      );
      expect(view.getByText("Healthy route")).toBeInTheDocument();
    });
  });
});
