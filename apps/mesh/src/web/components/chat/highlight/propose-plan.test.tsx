import { setupComponentTest } from "../../../../test/setup"; // happy-dom + jest-dom matchers
setupComponentTest();
import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render as renderBare } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ProposePlanHighlight } from "./propose-plan";
import type { PendingPlan } from "./extract-pending-plans";

// ProposePlanPrompt calls useT(), which reads language preference via TanStack Query.
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const render = (ui: Parameters<typeof renderBare>[0]) =>
  renderBare(ui, { wrapper });

describe("ProposePlanHighlight", () => {
  const plan = (toolCallId: string, text: string): PendingPlan => ({
    toolCallId,
    plan: text,
    state: "input-available",
  });

  it("renders nothing when there is no pending plan", () => {
    const { container } = render(
      <ProposePlanHighlight
        plans={[]}
        isStreaming={false}
        onApprove={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders only the most recently proposed plan", () => {
    const { getByText, queryByText } = render(
      <ProposePlanHighlight
        plans={[plan("c1", "First plan"), plan("c2", "Second plan")]}
        isStreaming={false}
        onApprove={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(getByText("Second plan")).toBeInTheDocument();
    expect(queryByText("First plan")).toBeNull();
  });

  it("approve button passes the active plan's text to onApprove", () => {
    const onApprove = mock();
    const { getByText } = render(
      <ProposePlanHighlight
        plans={[plan("c1", "Do the thing")]}
        isStreaming={false}
        onApprove={onApprove}
        onDismiss={() => {}}
      />,
    );
    fireEvent.click(getByText("Let's go"));
    expect(onApprove).toHaveBeenCalledWith("Do the thing");
  });

  it("dismiss button calls onDismiss", () => {
    const onDismiss = mock();
    const { getByText } = render(
      <ProposePlanHighlight
        plans={[plan("c1", "Do the thing")]}
        isStreaming={false}
        onApprove={() => {}}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(getByText("Keep iterating"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
