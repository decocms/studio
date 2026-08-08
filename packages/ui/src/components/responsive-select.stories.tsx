import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import {
  ResponsiveSelect,
  ResponsiveSelectContent,
  ResponsiveSelectItem,
  ResponsiveSelectTrigger,
  ResponsiveSelectValue,
} from "./responsive-select.tsx";

const meta = {
  title: "Components/ResponsiveSelect",
  component: ResponsiveSelect,
} satisfies Meta<typeof ResponsiveSelect>;

export default meta;
type Story = StoryObj<typeof meta>;

// Renders as a native-style select on desktop and as a bottom drawer on
// mobile viewports (resize the canvas below the mobile breakpoint to switch).
export const Default: Story = {
  render: () => (
    <ResponsiveSelect defaultValue="member">
      <ResponsiveSelectTrigger className="w-56">
        <ResponsiveSelectValue placeholder="Select a role" />
      </ResponsiveSelectTrigger>
      <ResponsiveSelectContent title="Select a role">
        <ResponsiveSelectItem value="owner">Owner</ResponsiveSelectItem>
        <ResponsiveSelectItem value="admin">Admin</ResponsiveSelectItem>
        <ResponsiveSelectItem value="member">Member</ResponsiveSelectItem>
        <ResponsiveSelectItem value="viewer">Viewer</ResponsiveSelectItem>
      </ResponsiveSelectContent>
    </ResponsiveSelect>
  ),
};

function ControlledDemo() {
  const [value, setValue] = useState("us-east-1");
  return (
    <div className="flex flex-col items-start gap-2">
      <ResponsiveSelect value={value} onValueChange={setValue}>
        <ResponsiveSelectTrigger className="w-56">
          <ResponsiveSelectValue placeholder="Select a region" />
        </ResponsiveSelectTrigger>
        <ResponsiveSelectContent title="Select a region">
          <ResponsiveSelectItem value="us-east-1">
            US East (Virginia)
          </ResponsiveSelectItem>
          <ResponsiveSelectItem value="us-west-2">
            US West (Oregon)
          </ResponsiveSelectItem>
          <ResponsiveSelectItem value="eu-west-1">
            EU West (Ireland)
          </ResponsiveSelectItem>
          <ResponsiveSelectItem value="sa-east-1">
            South America (Sao Paulo)
          </ResponsiveSelectItem>
        </ResponsiveSelectContent>
      </ResponsiveSelect>
      <span className="text-muted-foreground text-xs">
        Deploy region: {value}
      </span>
    </div>
  );
}

export const Controlled: Story = {
  render: () => <ControlledDemo />,
};
