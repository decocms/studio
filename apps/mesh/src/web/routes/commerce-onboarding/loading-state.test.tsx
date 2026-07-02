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
      "Preparando seu workspace de commerce...",
    );
    expect(getCommerceOnboardingLoadingLabel("generic")).toBe("Preparando...");
  });

  test("renders the full-page loading shell", () => {
    const { getByRole, getByText } = render(
      <CommerceOnboardingLoading variant="workspace" />,
    );

    expect(getByRole("status")).toBeInTheDocument();
    expect(
      getByText("Preparando seu workspace de commerce..."),
    ).toBeInTheDocument();
  });

  test("renders the diagnostic card skeleton loading state", () => {
    const { getByText, container } = render(<CompanionMcpsSectionSkeleton />);

    expect(
      getByText("Desbloqueie seu diagnóstico completo"),
    ).toBeInTheDocument();
    expect(
      getByText(
        "Conecte suas ferramentas para liberar mais de 100 verificações no seu funil.",
      ),
    ).toBeInTheDocument();
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(15);
  });
});
