import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();

import { fireEvent, render as renderBare } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "bun:test";
import type { ReactNode } from "react";
import { useForm } from "react-hook-form";
import { DefaultsOnCreateOnlyField } from "./defaults-on-create-only-field";

const LABEL = "Fill section defaults only in new sections";

// useT() reads the language preference through TanStack Query.
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

interface FormShape {
  metadata: { defaultsOnCreateOnly?: boolean | null };
}

function Harness({
  initial,
}: {
  initial: FormShape["metadata"]["defaultsOnCreateOnly"];
}) {
  const form = useForm<FormShape>({
    defaultValues: { metadata: { defaultsOnCreateOnly: initial } },
  });
  return (
    <>
      <DefaultsOnCreateOnlyField control={form.control} />
      <output data-testid="value">
        {String(form.watch("metadata.defaultsOnCreateOnly"))}
      </output>
    </>
  );
}

describe("DefaultsOnCreateOnlyField", () => {
  it("is off when the project never set it", () => {
    for (const initial of [undefined, null, false]) {
      const { getByRole, unmount } = renderBare(<Harness initial={initial} />, {
        wrapper,
      });
      expect(getByRole("switch", { name: LABEL })).not.toBeChecked();
      unmount();
    }
  });

  it("is on only for an explicit true", () => {
    const { getByRole } = renderBare(<Harness initial={true} />, { wrapper });
    expect(getByRole("switch", { name: LABEL })).toBeChecked();
  });

  it("turning it on writes true", () => {
    const { getByRole, getByTestId } = renderBare(
      <Harness initial={undefined} />,
      { wrapper },
    );
    fireEvent.click(getByRole("switch", { name: LABEL }));
    expect(getByRole("switch", { name: LABEL })).toBeChecked();
    expect(getByTestId("value")).toHaveTextContent("true");
  });
});
