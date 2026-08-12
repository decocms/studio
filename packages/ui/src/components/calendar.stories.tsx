import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import type { DateRange } from "react-day-picker";
import { Calendar } from "./calendar.tsx";

const meta = {
  title: "Components/Calendar",
  component: Calendar,
} satisfies Meta<typeof Calendar>;

export default meta;
type Story = StoryObj<typeof meta>;

function SingleDemo() {
  const [date, setDate] = useState<Date | undefined>(new Date());
  return (
    <Calendar
      mode="single"
      selected={date}
      onSelect={setDate}
      className="rounded-lg border border-border"
    />
  );
}

export const Default: Story = {
  render: () => <SingleDemo />,
};

function RangeDemo() {
  const today = new Date();
  const [range, setRange] = useState<DateRange | undefined>({
    from: new Date(today.getFullYear(), today.getMonth(), 4),
    to: new Date(today.getFullYear(), today.getMonth(), 12),
  });
  return (
    <Calendar
      mode="range"
      selected={range}
      onSelect={setRange}
      numberOfMonths={2}
      className="rounded-lg border border-border"
    />
  );
}

export const Range: Story = {
  render: () => <RangeDemo />,
};

function DisabledDaysDemo() {
  const [date, setDate] = useState<Date | undefined>();
  return (
    <Calendar
      mode="single"
      selected={date}
      onSelect={setDate}
      disabled={{ before: new Date() }}
      className="rounded-lg border border-border"
    />
  );
}

export const PastDaysDisabled: Story = {
  render: () => <DisabledDaysDemo />,
};
