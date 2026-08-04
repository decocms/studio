import { setupComponentTest } from "../../test/setup"; // happy-dom + jest-dom matchers
setupComponentTest();
import { describe, expect, it, mock } from "bun:test";
import { act, fireEvent, render as renderBare } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { AuthConfig } from "@decocms/shared/config";

const AUTH_CONFIG: AuthConfig = {
  emailAndPassword: { enabled: true },
  magicLink: { enabled: false },
  emailOtp: { enabled: false },
  socialProviders: {
    enabled: true,
    providers: [{ name: "google" }],
  },
  resetPassword: { enabled: false },
  sso: { enabled: false },
  stdioEnabled: false,
  localMode: false,
};

mock.module("@/providers/auth-config-provider", () => ({
  useAuthConfig: () => AUTH_CONFIG,
}));

mock.module("@/lib/posthog-client", () => ({
  track: () => {},
}));

const { UnifiedAuthForm } = await import("./unified-auth-form");

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const render = (ui: Parameters<typeof renderBare>[0]) =>
  renderBare(ui, { wrapper });

describe("UnifiedAuthForm", () => {
  it("clears a stale social sign-in error once the user edits the email field", async () => {
    const { getByRole, getByLabelText, queryByRole } = render(
      <UnifiedAuthForm
        actions={{
          socialSignIn: () => Promise.reject(new Error("provider down")),
        }}
      />,
    );

    await act(async () => {
      fireEvent.click(getByRole("button", { name: /Continue with Google/i }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(queryByRole("alert")).toBeInTheDocument();

    const emailInput = getByLabelText("Email") as HTMLInputElement;
    fireEvent.input(emailInput, {
      target: { value: "a" },
    });

    expect(queryByRole("alert")).toBeNull();
  });
});
