import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";

import { AgentHomeHeader } from "./agent-home-header";

describe("AgentHomeHeader", () => {
  it("renders the selected branch after the agent title as muted text", () => {
    const { getByText } = render(
      <AgentHomeHeader
        agent={{
          icon: null,
          title: "Super Agent",
        }}
        currentBranch="feature/chat-empty-branch"
      />,
    );

    expect(getByText("Super Agent")).toBeInTheDocument();
    expect(getByText("/")).toHaveClass("text-muted-foreground");
    expect(getByText("feature/chat-empty-branch")).toHaveClass(
      "text-muted-foreground",
    );
  });

  it("omits the branch separator when no branch is selected", () => {
    const { queryByText } = render(
      <AgentHomeHeader
        agent={{
          icon: null,
          title: "Super Agent",
        }}
        currentBranch={null}
      />,
    );

    expect(queryByText("/")).toBeNull();
  });
});
