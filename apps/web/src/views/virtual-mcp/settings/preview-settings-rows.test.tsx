import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();

import { act, fireEvent, render as renderBare } from "@testing-library/react";
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

/**
 * Types into a controlled input: happy-dom's value setter doesn't reach
 * React here, so this calls the field's own `onChange` (as in
 * campaigns-view.test.tsx).
 */
function typeInto(element: HTMLElement, value: string) {
  const propsKey = Object.keys(element).find((k) =>
    k.startsWith("__reactProps$"),
  );
  const onChange = (
    element as unknown as Record<
      string,
      { onChange?: (event: { target: { value: string } }) => void }
    >
  )[propsKey ?? ""]?.onChange;
  if (!onChange) throw new Error("not a controlled field");
  // A block: the form's onChange returns a promise act would wait on.
  act(() => {
    onChange({ target: { value } });
  });
}

interface FormShape {
  metadata: {
    previewServerUrl: string;
    fastPreview: boolean;
    fastPreviewInPlace: boolean;
    pullRequestDrafts: boolean;
    mobileApp?: { protocol: string } | null;
  };
}

function Harness({
  isBlocksV8,
  fastPreview,
  previewServerUrl = "https://acme.com",
  mobileApp = null,
  onMobileApp,
  backgroundCommit,
}: {
  backgroundCommit?: ReactNode;
  isBlocksV8: boolean;
  fastPreview: boolean;
  previewServerUrl?: string;
  mobileApp?: { protocol: string } | null;
  onMobileApp?: (value: unknown) => void;
}) {
  const form = useForm<FormShape>({
    defaultValues: {
      metadata: {
        previewServerUrl,
        fastPreview,
        fastPreviewInPlace: false,
        pullRequestDrafts: false,
        mobileApp,
      },
    },
  });
  onMobileApp?.(form.watch("metadata.mobileApp"));
  return (
    <PreviewSettingsRows
      control={form.control}
      isBlocksV8={isBlocksV8}
      previewServerUrl={form.watch("metadata.previewServerUrl")}
      fastPreview={form.watch("metadata.fastPreview")}
      backgroundCommit={backgroundCommit}
    />
  );
}

describe("PreviewSettingsRows", () => {
  it("offers the organization's background-commit row only on v7 with Fast Preview on", () => {
    const row = <p>background commit row</p>;
    const cases = [
      { isBlocksV8: false, fastPreview: true, shown: true },
      { isBlocksV8: false, fastPreview: false, shown: false },
      { isBlocksV8: true, fastPreview: true, shown: false },
    ];
    for (const { shown, ...props } of cases) {
      const { queryByText, unmount } = renderBare(
        <Harness {...props} backgroundCommit={row} />,
        { wrapper },
      );
      expect(!!queryByText("background commit row")).toBe(shown);
      unmount();
    }
  });

  it("v7: the preview URL, the Fast Preview switch and in-place render, as on main", () => {
    const { queryByText, getByRole } = renderBare(
      <Harness isBlocksV8={false} fastPreview />,
      { wrapper },
    );
    expect(queryByText("Fast Preview")).toBeInTheDocument();
    expect(getByRole("switch", { name: "Fast Preview" })).toBeChecked();
    expect(queryByText("Instant preview (experimental)")).toBeInTheDocument();
    expect(
      getByRole("switch", { name: "Pull request drafts" }),
    ).not.toBeChecked();
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
    expect(queryByText("Pull request drafts")).not.toBeInTheDocument();
  });

  it("Blocks v8: no Fast Preview switch; in-place render is always offered", () => {
    for (const fastPreview of [true, false]) {
      const { queryByText, getAllByRole, unmount } = renderBare(
        <Harness isBlocksV8 fastPreview={fastPreview} />,
        { wrapper },
      );
      expect(queryByText("Fast Preview")).not.toBeInTheDocument();
      expect(queryByText("Instant preview (experimental)")).toBeInTheDocument();
      // In-place render and Mobile app.
      expect(getAllByRole("switch")).toHaveLength(2);
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

  it("Blocks v8: the Mobile app switch writes metadata.mobileApp and shows its fields", () => {
    let value: unknown;
    const { getByRole, getByLabelText, queryByLabelText, queryByText } =
      renderBare(
        <Harness
          isBlocksV8
          fastPreview={false}
          onMobileApp={(v) => {
            value = v;
          }}
        />,
        { wrapper },
      );
    const toggle = getByRole("switch", { name: "Mobile app (Eitri)" });
    expect(toggle).not.toBeChecked();
    expect(queryByLabelText("App's Eitri protocol")).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(value).toEqual({ protocol: "" });
    const protocol = getByLabelText("App's Eitri protocol");
    expect(protocol).toHaveAttribute("placeholder", "newbalance");
    typeInto(protocol, "newbalance");
    expect(value).toEqual({ protocol: "newbalance" });
    typeInto(
      getByLabelText("iOS install link"),
      "https://testflight.apple.com/join/B9wsWdMp",
    );
    expect(value).toEqual({
      protocol: "newbalance",
      iosInstallUrl: "https://testflight.apple.com/join/B9wsWdMp",
    });
    // Cleared, an install link is left out.
    typeInto(getByLabelText("iOS install link"), "");
    expect(value).toEqual({ protocol: "newbalance" });

    typeInto(protocol, "New Balance");
    expect(queryByText(/Use lowercase letters/)).toBeInTheDocument();

    fireEvent.click(getByRole("switch", { name: "Mobile app (Eitri)" }));
    expect(value).toBeNull();
    expect(queryByLabelText("App's Eitri protocol")).not.toBeInTheDocument();
  });

  it("v7: no Mobile app switch", () => {
    const { queryByRole } = renderBare(
      <Harness isBlocksV8={false} fastPreview />,
      { wrapper },
    );
    expect(queryByRole("switch", { name: "Mobile app (Eitri)" })).toBeNull();
  });
});
