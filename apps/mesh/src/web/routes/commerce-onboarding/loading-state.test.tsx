import { setupComponentTest } from "../../../test/setup";
setupComponentTest();

import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, test } from "bun:test";
import {
  CommerceOnboardingLoading,
  getCommerceOnboardingLoadingLabel,
} from "./loading-state";
import { CompanionMcpsSectionSkeleton } from "./companion-mcps-section";

describe("commerce onboarding loading state", () => {
  test("centralizes copy for full-page loading variants", () => {
    expect(getCommerceOnboardingLoadingLabel("workspace")).toBe(
      "Preparing your commerce workspace...",
    );
    expect(getCommerceOnboardingLoadingLabel("generic")).toBe(
      "Preparing workspace...",
    );
  });

  test("renders the full-page loading shell", () => {
    const { getByRole, getByText } = render(
      <CommerceOnboardingLoading variant="workspace" />,
    );

    expect(getByRole("status")).toBeInTheDocument();
    expect(
      getByText("Preparing your commerce workspace..."),
    ).toBeInTheDocument();
  });

  test("renders the diagnostic card skeleton loading state", () => {
    const { getByText, container } = render(<CompanionMcpsSectionSkeleton />);

    expect(getByText("Unlock your full diagnostic")).toBeInTheDocument();
    expect(
      getByText("Connect your tools to unlock 100+ checks across your funnel."),
    ).toBeInTheDocument();
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(15);
  });
});
