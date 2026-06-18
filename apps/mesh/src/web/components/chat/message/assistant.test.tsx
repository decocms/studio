import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MessageAssistant } from "./assistant";

describe("MessageAssistant", () => {
  it("renders the empty waiting state with shared thought-summary row copy", () => {
    const { getByText } = render(
      <MessageAssistant
        message={null}
        status="submitted"
        isLast
        turnStartedAt={null}
      />,
    );

    expect(getByText("Planning next moves...")).toBeInTheDocument();
    expect(getByText("Deciding how to approach the request")).toHaveClass(
      "bg-muted/50",
    );
  });
});
