import type { Meta, StoryObj } from "@storybook/react-vite";
import { Copy01, Pencil01, Trash01 } from "@untitledui/icons";
import { IconButton } from "./icon-button.tsx";

const meta = {
  title: "Components/IconButton",
  component: IconButton,
  args: {
    label: "Copy value",
    variant: "ghost",
    size: "icon-sm",
  },
  argTypes: {
    variant: {
      control: "select",
      options: ["ghost", "outline", "secondary", "default", "destructive"],
    },
    size: { control: "select", options: ["icon-sm", "icon"] },
    tooltipSide: {
      control: "select",
      options: ["top", "right", "bottom", "left"],
    },
  },
} satisfies Meta<typeof IconButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <IconButton {...args}>
      <Copy01 />
    </IconButton>
  ),
};

export const RowActions: Story = {
  render: () => (
    <div className="flex items-center gap-1 rounded-lg border border-border px-3 py-2">
      <span className="mr-auto font-mono text-xs">API_BASE_URL</span>
      <IconButton label="Edit value">
        <Pencil01 />
      </IconButton>
      <IconButton label="Delete variable">
        <Trash01 />
      </IconButton>
    </div>
  ),
};
