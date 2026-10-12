import { setupComponentTest } from "../../../../test/setup"; // happy-dom + jest-dom matchers
setupComponentTest();
import { afterEach, describe, expect, it } from "bun:test";
import {
  cleanup,
  fireEvent,
  render as renderBare,
} from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { UserAskToolPart } from "../types";
import { UserAskQuestionHighlight } from "./user-ask-question";

// UserAskPrompt calls useT(), which reads language preference via TanStack Query.
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const render = (ui: Parameters<typeof renderBare>[0]) =>
  renderBare(ui, { wrapper });

const pendingChoice = {
  type: "tool-user_ask",
  toolCallId: "q1",
  state: "input-available",
  input: { type: "choice", prompt: "Pick one", options: ["A", "B", "C"] },
} as UserAskToolPart;

function renderPendingChoice() {
  render(
    <UserAskQuestionHighlight
      userAskParts={[pendingChoice]}
      isStreaming={false}
      onSubmit={() => {}}
    />,
  );
}

describe("UserAskQuestionHighlight number shortcut", () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  it("selects an option when a digit is pressed outside any text field", () => {
    renderPendingChoice();

    const notCancelled = fireEvent.keyDown(document.body, { key: "2" });

    expect(notCancelled).toBe(false);
  });

  it("leaves digits typed in a contentEditable composer to the composer", () => {
    renderPendingChoice();
    const composer = document.createElement("div");
    composer.contentEditable = "true";
    document.body.appendChild(composer);

    const notCancelled = fireEvent.keyDown(composer, { key: "2" });

    expect(notCancelled).toBe(true);
  });
});
