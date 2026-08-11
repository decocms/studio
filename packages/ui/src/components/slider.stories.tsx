import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Label } from "./label.tsx";
import { Slider } from "./slider.tsx";

const meta = {
  title: "Components/Slider",
  component: Slider,
} satisfies Meta<typeof Slider>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { defaultValue: [50], max: 100, step: 1 },
  render: (args) => (
    <div className="w-80">
      <Slider {...args} />
    </div>
  ),
};

function TemperatureDemo() {
  const [value, setValue] = useState([0.7]);
  return (
    <div className="grid w-80 gap-3">
      <div className="flex items-center justify-between">
        <Label htmlFor="temperature">Temperature</Label>
        <span className="text-sm text-muted-foreground">{value[0]}</span>
      </div>
      <Slider
        id="temperature"
        value={value}
        onValueChange={setValue}
        min={0}
        max={2}
        step={0.1}
      />
      <p className="text-sm text-muted-foreground">
        Higher values make model output more creative.
      </p>
    </div>
  );
}

export const WithValueLabel: Story = {
  render: () => <TemperatureDemo />,
};

export const Range: Story = {
  render: () => (
    <div className="grid w-80 gap-3">
      <Label>Retry delay window (seconds)</Label>
      <Slider defaultValue={[5, 60]} min={0} max={120} step={5} />
    </div>
  ),
};

export const Disabled: Story = {
  render: () => (
    <div className="w-80">
      <Slider defaultValue={[30]} disabled />
    </div>
  ),
};

export const Vertical: Story = {
  render: () => (
    <div className="h-48">
      <Slider defaultValue={[60]} orientation="vertical" />
    </div>
  ),
};
