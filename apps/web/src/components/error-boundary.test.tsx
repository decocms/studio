import { setupComponentTest } from "../../test/setup"; // happy-dom + jest-dom matchers
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { render as renderBare } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ChunkErrorBoundary, ErrorBoundary } from "./error-boundary";

// useT() reads the language preference through TanStack Query.
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const render = (ui: Parameters<typeof renderBare>[0]) =>
  renderBare(ui, { wrapper });

function Throws({ message }: { message: string }): React.ReactElement {
  throw new TypeError(message);
}

const STALE_CHUNK =
  "Failed to fetch dynamically imported module: https://example.com/assets/thread-route-1.js";

describe("ChunkErrorBoundary", () => {
  it("takes a stale chunk error over from a nested default boundary", () => {
    const { getByText, queryByText } = render(
      <ChunkErrorBoundary>
        <ErrorBoundary>
          <Throws message={STALE_CHUNK} />
        </ErrorBoundary>
      </ChunkErrorBoundary>,
    );
    expect(getByText("New version available")).toBeInTheDocument();
    expect(queryByText(STALE_CHUNK)).not.toBeInTheDocument();
  });

  it("leaves a stale chunk error to a nested boundary with its own fallback", () => {
    const { getByText, queryByText } = render(
      <ChunkErrorBoundary>
        <ErrorBoundary fallback={<p>widget failed</p>}>
          <Throws message={STALE_CHUNK} />
        </ErrorBoundary>
      </ChunkErrorBoundary>,
    );
    expect(getByText("widget failed")).toBeInTheDocument();
    expect(queryByText("New version available")).not.toBeInTheDocument();
  });

  it("shows a plain network failure as an error, not a new version", () => {
    const { getByText, queryByText } = render(
      <ChunkErrorBoundary>
        <Throws message="Failed to fetch" />
      </ChunkErrorBoundary>,
    );
    expect(getByText("Something went wrong")).toBeInTheDocument();
    expect(queryByText("New version available")).not.toBeInTheDocument();
  });
});
