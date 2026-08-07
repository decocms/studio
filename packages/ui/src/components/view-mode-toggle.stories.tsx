import type { Meta, StoryObj } from "@storybook/react-vite";
import { Grid01, List, Rows01 } from "@untitledui/icons";
import { useState } from "react";
import { ViewModeToggle, type ViewModeOption } from "./view-mode-toggle.tsx";

const meta = {
  title: "Components/ViewModeToggle",
  component: ViewModeToggle,
  // All stories use render(); args only satisfy the required props.
  args: {
    value: "grid",
    onValueChange: () => {},
    options: [],
  },
} satisfies Meta<typeof ViewModeToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

type Mode = "grid" | "list";

const iconOptions: Array<ViewModeOption<Mode>> = [
  { value: "grid", icon: <Grid01 />, tooltip: "Grid view" },
  { value: "list", icon: <List />, tooltip: "List view" },
];

function Demo({
  options = iconOptions,
  size,
  fullWidth,
  className,
}: {
  options?: Array<ViewModeOption<Mode>>;
  size?: "sm" | "md" | "lg";
  fullWidth?: boolean;
  className?: string;
}) {
  const [value, setValue] = useState<Mode>("grid");
  return (
    <ViewModeToggle
      value={value}
      onValueChange={setValue}
      options={options}
      size={size}
      fullWidth={fullWidth}
      className={className}
    />
  );
}

export const Default: Story = {
  render: () => <Demo />,
};

export const WithLabels: Story = {
  render: () => (
    <Demo
      options={[
        { value: "grid", icon: <Grid01 />, label: "Grid" },
        { value: "list", icon: <Rows01 />, label: "List" },
      ]}
    />
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <Demo size="sm" />
      <Demo size="md" />
      <Demo size="lg" />
    </div>
  ),
};

export const FullWidth: Story = {
  render: () => (
    <div className="w-80">
      <Demo
        fullWidth
        options={[
          { value: "grid", icon: <Grid01 />, label: "Grid" },
          { value: "list", icon: <Rows01 />, label: "List" },
        ]}
      />
    </div>
  ),
};
