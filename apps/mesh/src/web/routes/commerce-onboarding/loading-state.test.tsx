import { setupComponentTest } from "../../../test/setup";
setupComponentTest();

import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, test } from "bun:test";
import {
  CommerceOnboardingLoading,
  getCommerceOnboardingLoadingLabel,
} from "./loading-state";

describe("commerce onboarding loading state", () => {
  test("centralizes copy for every loading variant", () => {
    expect(getCommerceOnboardingLoadingLabel("route")).toBe(
      "Preparing commerce onboarding...",
    );
    expect(getCommerceOnboardingLoadingLabel("workspace")).toBe(
      "Preparing your commerce workspace...",
    );
    expect(getCommerceOnboardingLoadingLabel("connect")).toBe(
      "Connecting workspace...",
    );
    expect(getCommerceOnboardingLoadingLabel("setup")).toBe(
      "Setting up Commerce Discovery...",
    );
    expect(getCommerceOnboardingLoadingLabel("button")).toBe("Setting up");
  });

  test("renders the full-page loading shell", () => {
    const { getByRole, getByText } = render(
      <CommerceOnboardingLoading variant="connect" />,
    );

    expect(getByRole("status")).toBeInTheDocument();
    expect(getByText("Connecting workspace...")).toBeInTheDocument();
  });
});
