import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { fireEvent, render as renderBare } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { OrderMonitorDay } from "@decocms/shared/order-monitor";
import { CancellationsChart, splitRunningHour } from "./order-monitor-day";

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

describe("splitRunningHour", () => {
  const today = [10, 40, 8, ...new Array(21).fill(null)];

  it("draws the running hour as its hourly pace, dashed from the hour before", () => {
    // 2 hours and 1 bucket in: 02:00 has its first 15 minutes.
    const { full, pace } = splitRunningHour(today, 9);
    expect(full.slice(0, 3)).toEqual([10, 40, null]);
    expect(pace.slice(0, 3)).toEqual([null, 40, 32]);
    expect(pace.slice(3).every((v) => v === null)).toBe(true);
  });

  it("leaves a day whose last hour is complete untouched", () => {
    const { full, pace } = splitRunningHour(today, 12);
    expect(full).toEqual(today);
    expect(pace.every((v) => v === null)).toBe(true);
  });

  it("has nothing to connect to in the first hour", () => {
    const { full, pace } = splitRunningHour(
      [3, ...new Array(23).fill(null)],
      2,
    );
    expect(full[0]).toBeNull();
    expect(pace[0]).toBe(6);
  });
});
