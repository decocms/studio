import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();

import { render as renderBare, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "bun:test";
import type { ReactNode } from "react";
import { useForm } from "react-hook-form";
import type { VirtualMcpFormData } from "../types";
import { ProjectIdentity } from "./project-identity";

// Queried lazily: the DOM exists only after setupComponentTest runs.
const screen = () => within(document.body);

// useT() reads the language preference through TanStack Query.
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function Harness() {
  const form = useForm<VirtualMcpFormData>({
    defaultValues: {
      title: "Acme Store",
      description: "",
      icon: null,
      metadata: { siteSlug: "acme-store" },
    } as unknown as VirtualMcpFormData,
  });
  return <ProjectIdentity form={form} onCommit={async () => {}} />;
}

describe("ProjectIdentity (Settings → General)", () => {
  it("shows the name and description, and no site id (it lives on the CMS section)", () => {
    renderBare(<Harness />, { wrapper });
    expect(screen().getByLabelText("Project name")).toHaveValue("Acme Store");
    expect(screen().getByLabelText("Description")).toBeInTheDocument();
    expect(screen().queryByLabelText(/site id/i)).toBeNull();
    expect(screen().queryByText(/site id/i)).toBeNull();
    expect(
      screen().queryByRole("button", { name: /copy site id/i }),
    ).toBeNull();
    expect(screen().queryByDisplayValue("acme-store")).toBeNull();
  });
});
