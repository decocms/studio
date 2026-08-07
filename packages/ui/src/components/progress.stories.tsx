import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./button.tsx";
import { Progress } from "./progress.tsx";

const meta = {
  title: "Components/Progress",
  component: Progress,
  args: {
    value: 40,
  },
  argTypes: {
    value: {
      control: { type: "range", min: 0, max: 100 },
    },
  },
} satisfies Meta<typeof Progress>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => <Progress {...args} className="w-80" />,
};

export const Values: Story = {
  render: () => (
    <div className="flex w-80 flex-col gap-4">
      <Progress value={0} />
      <Progress value={25} />
      <Progress value={60} />
      <Progress value={100} />
    </div>
  ),
};

function UsageDemo() {
  const [used, setUsed] = useState(6.5);
  const limit = 10;
  return (
    <div className="flex w-80 flex-col gap-2">
      <div className="flex justify-between text-sm">
        <span className="text-foreground font-medium">Monthly tool calls</span>
        <span className="text-muted-foreground">
          {used.toFixed(1)}k / {limit}k
        </span>
      </div>
      <Progress value={(used / limit) * 100} />
      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() => setUsed((u) => Math.min(u + 0.5, limit))}
      >
        Simulate usage
      </Button>
    </div>
  );
}

export const WithLabel: Story = {
  render: () => <UsageDemo />,
};
