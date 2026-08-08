import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { QUICK_RANGES } from "../lib/time-expressions.ts";
import { TimeRangePicker, type TimeRange } from "./time-range-picker.tsx";

const meta = {
  title: "Components/TimeRangePicker",
  component: TimeRangePicker,
  args: {
    value: { from: "now-24h", to: "now" },
    onChange: () => {},
  },
} satisfies Meta<typeof TimeRangePicker>;

export default meta;
type Story = StoryObj<typeof meta>;

function ControlledDemo({
  quickRanges,
}: {
  quickRanges?: typeof QUICK_RANGES;
}) {
  const [range, setRange] = useState<TimeRange>({ from: "now-24h", to: "now" });
  return (
    <div className="space-y-2">
      <TimeRangePicker
        value={range}
        onChange={setRange}
        quickRanges={quickRanges}
      />
      <p className="text-xs text-muted-foreground">
        From {range.from} to {range.to}
      </p>
    </div>
  );
}

/** Click the trigger to pick a quick range or an absolute range. */
export const Default: Story = {
  render: () => <ControlledDemo />,
};

/** Only day-level quick ranges, e.g. for a slower-moving dashboard. */
export const CustomQuickRanges: Story = {
  render: () => (
    <ControlledDemo
      quickRanges={QUICK_RANGES.filter((r) => r.value.endsWith("d"))}
    />
  ),
};

export const Disabled: Story = {
  args: { disabled: true },
};
