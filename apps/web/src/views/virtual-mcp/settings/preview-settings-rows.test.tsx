import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();

import { render as renderBare } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "bun:test";
import type { ReactNode } from "react";
import { useForm } from "react-hook-form";
import { PreviewSettingsRows } from "./preview-settings-rows";

// useT() reads the language preference through TanStack Query.
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

interface FormShape {
  metadata: {
    previewServerUrl: string;
    fastPreview: boolean;
    fastPreviewInPlace: boolean;
  };
}

function Harness({
  isBlocksV8,
  fastPreview,
  previewServerUrl = "https://acme.com",
}: {
  isBlocksV8: boolean;
  fastPreview: boolean;
  previewServerUrl?: string;
}) {
  const form = useForm<FormShape>({
    defaultValues: {
      metadata: {
        previewServerUrl,
        fastPreview,
        fastPreviewInPlace: false,
      },
    },
  });
  return (
    <PreviewSettingsRows
      control={form.control}
      isBlocksV8={isBlocksV8}
      previewServerUrl={form.watch("metadata.previewServerUrl")}
      fastPreview={form.watch("metadata.fastPreview")}
    />
  );
}

describe("PreviewSettingsRows", () => {
  it("v7: the preview URL, the Fast Preview switch and in-place render, as on main", () => {
    const { queryByText, getByRole } = renderBare(
      <Harness isBlocksV8={false} fastPreview />,
      { wrapper },
    );
    expect(queryByText("Fast Preview")).toBeInTheDocument();
    expect(getByRole("switch", { name: "Fast Preview" })).toBeChecked();
    expect(queryByText("Instant preview (experimental)")).toBeInTheDocument();
  });

  it("v7 with Fast Preview off: the switch, no in-place render", () => {
    const { queryByText } = renderBare(
      <Harness isBlocksV8={false} fastPreview={false} />,
      { wrapper },
    );
    expect(queryByText("Fast Preview")).toBeInTheDocument();
    expect(
      queryByText("Instant preview (experimental)"),
    ).not.toBeInTheDocument();
  });

  it("Blocks v8: no Fast Preview switch; in-place render is always offered", () => {
    for (const fastPreview of [true, false]) {
      const { queryByText, getAllByRole, unmount } = renderBare(
        <Harness isBlocksV8 fastPreview={fastPreview} />,
        { wrapper },
      );
      expect(queryByText("Fast Preview")).not.toBeInTheDocument();
      expect(queryByText("Instant preview (experimental)")).toBeInTheDocument();
      expect(getAllByRole("switch")).toHaveLength(1);
      expect(queryByText(/Add your site's address/)).not.toBeInTheDocument();
      unmount();
    }
  });

  it("Blocks v8 without a site address: a hint where the switch was", () => {
    const { queryByText } = renderBare(
      <Harness isBlocksV8 fastPreview={false} previewServerUrl="" />,
      { wrapper },
    );
    expect(queryByText("Fast Preview")).not.toBeInTheDocument();
    expect(queryByText(/Add your site's address/)).toBeInTheDocument();
  });

  it("names Fast Preview in the preview server hint on v7 only", () => {
    const v7 = renderBare(<Harness isBlocksV8={false} fastPreview />, {
      wrapper,
    });
    expect(v7.queryByText(/Required for Fast Preview/)).toBeInTheDocument();
    v7.unmount();
    const v8 = renderBare(<Harness isBlocksV8 fastPreview={false} />, {
      wrapper,
    });
    expect(v8.queryByText(/Fast Preview/)).not.toBeInTheDocument();
    expect(
      v8.queryByText(/Studio shows your drafts on it/),
    ).toBeInTheDocument();
  });
});
