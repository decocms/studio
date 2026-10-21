import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { fireEvent, render as renderBare } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { OrderMonitorDay } from "@decocms/shared/order-monitor";
import { CancellationsChart } from "./order-monitor-day";

// useT() reads the language preference through TanStack Query.
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const render = (ui: Parameters<typeof renderBare>[0]) =>
  renderBare(ui, { wrapper });

const EMPTY_SERIES = {
  today: new Array(24).fill(0),
  d1: new Array(24).fill(0),
  w1: new Array(24).fill(0),
  y1: new Array(24).fill(0),
};

const DAY = {
  cancellations: {
    canceled: EMPTY_SERIES,
    denied: EMPTY_SERIES,
    approximate: { d1: false, w1: false, y1: false },
    canceledWarnAt: new Array(24).fill(null),
    canceledAlertAt: new Array(24).fill(null),
  },
} as unknown as OrderMonitorDay;

describe("CancellationsChart", () => {
  it("exposes the selected kind via aria-pressed on its toggle buttons", () => {
    const { getByRole } = render(
      <CancellationsChart day={DAY} pushes={undefined} />,
    );

    const canceled = getByRole("button", { name: "Canceled" });
    const denied = getByRole("button", { name: "Payment denied" });
    expect(canceled).toHaveAttribute("aria-pressed", "true");
    expect(denied).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(denied);
    expect(denied).toHaveAttribute("aria-pressed", "true");
    expect(canceled).toHaveAttribute("aria-pressed", "false");
  });
});
