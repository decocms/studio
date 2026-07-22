import { setupComponentTest } from "../../test/setup"; // happy-dom + jest-dom matchers
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Component } from "react";
import { MonacoErrorBoundary } from "./monaco-error-boundary";

function Throws({ message }: { message: string }): React.ReactElement {
  throw new Error(message);
}

// Throws only on its first mount, then renders normally on remount (the
// shape of the real Monaco disposal error, which is transient).
function ThrowsOnFirstMount({ mountKey }: { mountKey?: number }) {
  if (!mountKey) {
    throw new Error("InstantiationService has been disposed");
  }
  return <div data-testid="recovered" />;
}

describe("MonacoErrorBoundary", () => {
  it("recovers from the Monaco disposal error by remounting children with a fresh mountKey", () => {
    const { getByTestId } = render(
      <MonacoErrorBoundary>
        <ThrowsOnFirstMount />
      </MonacoErrorBoundary>,
    );
    expect(getByTestId("recovered")).toBeInTheDocument();
  });

  it("rethrows errors that aren't the Monaco disposal error", () => {
    class Catcher extends Component<
      { children: React.ReactNode },
      { error: Error | null }
    > {
      override state = { error: null as Error | null };
      static getDerivedStateFromError(error: Error) {
        return { error };
      }
      override render() {
        return this.state.error ? null : this.props.children;
      }
    }

    // Silence React's error-boundary console noise for this expected throw.
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const { container } = render(
        <Catcher>
          <MonacoErrorBoundary>
            <Throws message="some unrelated error" />
          </MonacoErrorBoundary>
        </Catcher>,
      );
      expect(container).toBeEmptyDOMElement();
    } finally {
      console.error = originalConsoleError;
    }
  });
});
