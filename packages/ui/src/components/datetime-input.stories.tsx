import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { DateTimeInput } from "./datetime-input.tsx";

const meta = {
  title: "Components/DateTimeInput",
  component: DateTimeInput,
  args: {
    value: "now-24h",
    onChange: () => {},
  },
} satisfies Meta<typeof DateTimeInput>;

export default meta;
type Story = StoryObj<typeof meta>;

function ControlledDemo({ initialValue }: { initialValue: string }) {
  const [value, setValue] = useState(initialValue);
  return (
    <div className="w-80 space-y-2">
      <DateTimeInput value={value} onChange={setValue} />
      <p className="text-xs text-muted-foreground">Value: {value}</p>
    </div>
  );
}

/** Accepts relative expressions like "now" or "now-24h". */
export const Default: Story = {
  render: () => <ControlledDemo initialValue="now-24h" />,
};

/** Absolute dates render in "YYYY-MM-DD HH:MM:SS" format; the calendar button picks a date. */
export const AbsoluteDate: Story = {
  render: () => <ControlledDemo initialValue="2026-08-01T09:30:00.000Z" />,
};

export const WithError: Story = {
  render: () => (
    <div className="w-80">
      <DateTimeInput
        value="now-24h"
        onChange={() => {}}
        error="'From' must be before 'To'"
      />
    </div>
  ),
};

export const Disabled: Story = {
  args: { disabled: true },
  render: (args) => (
    <div className="w-80">
      <DateTimeInput {...args} />
    </div>
  ),
};
