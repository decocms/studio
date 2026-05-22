import { setupComponentTest } from "../../../test/setup"; // happy-dom + jest-dom matchers
setupComponentTest();
import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AgentModelTriggerPure } from "./agent-model-trigger";
import { getAgentSections } from "./select-model/agent-models";

const ALL = getAgentSections({
  hasAnyKey: true,
  link: { online: true, capabilities: ["claude-code", "codex"] },
});

describe("AgentModelTriggerPure", () => {
  test("closed pill is neutral when active agent is Decopilot", () => {
    const { container } = render(
      <AgentModelTriggerPure
        sections={ALL}
        activeAgent="decopilot"
        activeTier="smart"
        onSelect={() => {}}
      />,
    );
    const button = container.querySelector("button");
    expect(button?.className).not.toMatch(/text-success/);
    expect(button?.className).not.toMatch(/bg-success\/10/);
  });

  test("closed pill gets text-success and bg-success/10 when CLI agent active", () => {
    const { container } = render(
      <AgentModelTriggerPure
        sections={ALL}
        activeAgent="claude-code"
        activeTier="thinking"
        onSelect={() => {}}
      />,
    );
    const button = container.querySelector("button");
    expect(button?.className).toMatch(/text-success/);
    expect(button?.className).toMatch(/bg-success\/10/);
  });

  test("closed pill uses responsive gap so collapsed label doesn't leave phantom gap", () => {
    const { container } = render(
      <AgentModelTriggerPure
        sections={ALL}
        activeAgent="decopilot"
        activeTier="smart"
        onSelect={() => {}}
      />,
    );
    const button = container.querySelector("button");
    expect(button?.className).toMatch(/\bgap-0\b/);
    expect(button?.className).toMatch(/@\[496px\]\/chat-bottom:gap-1\.5/);
  });

  test("label reflects the active CLI tier model label (Opus 4.7)", () => {
    const { getByText } = render(
      <AgentModelTriggerPure
        sections={ALL}
        activeAgent="claude-code"
        activeTier="thinking"
        onSelect={() => {}}
      />,
    );
    expect(getByText("Opus 4.7")).toBeInTheDocument();
  });

  test("label reflects the active Decopilot tier label (Smart)", () => {
    const { getByText } = render(
      <AgentModelTriggerPure
        sections={ALL}
        activeAgent="decopilot"
        activeTier="smart"
        onSelect={() => {}}
      />,
    );
    expect(getByText("Smart")).toBeInTheDocument();
  });
});
