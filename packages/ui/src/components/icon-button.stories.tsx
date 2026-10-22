import type { Meta, StoryObj } from "@storybook/react-vite";
import { Copy01, Pencil01, Trash01 } from "@untitledui/icons";
import { IconButton } from "./icon-button.tsx";
import { Matrix } from "../foundations/kit.tsx";
import { Button } from "./button.tsx";

const meta = {
  title: "Atoms/IconButton",
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

export const States: Story = {
  parameters: {
    controls: { disable: true },
    layout: "padded",
    pseudo: {
      hover: [".is-hover"],
      focusVisible: [".is-focus"],
      active: [".is-active"],
    },
  },
  render: () => (
    <Matrix
      columns={["Default", "Hover", "Focus", "Disabled"]}
      rows={(["ghost", "secondary", "outline", "default"] as const).flatMap(
        (variant) =>
          (["icon-sm", "icon"] as const).map((size) => ({
            label: `${variant === "default" ? "primary" : variant} · ${size === "icon" ? 32 : 28}`,
            cells: ["", "is-hover", "is-focus", "disabled"].map((state) => (
              <Button
                key={state}
                variant={variant}
                size={size}
                className={state}
                disabled={state === "disabled"}
                aria-label="Edit"
              >
                <Pencil01 />
              </Button>
            )),
          })),
      )}
    />
  ),
};
