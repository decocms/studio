import type { Meta, StoryObj } from "@storybook/react-vite";
import { Separator } from "./separator.tsx";

const meta = {
  title: "Components/Separator",
  component: Separator,
  args: {
    orientation: "horizontal",
  },
  argTypes: {
    orientation: {
      control: "select",
      options: ["horizontal", "vertical"],
    },
  },
} satisfies Meta<typeof Separator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="w-80">
      <div className="space-y-1">
        <h4 className="text-sm font-medium">Organization settings</h4>
        <p className="text-sm text-muted-foreground">
          Manage members, billing, and connections.
        </p>
      </div>
      <Separator className="my-4" />
      <div className="flex h-5 items-center gap-4 text-sm">
        <span>Members</span>
        <Separator orientation="vertical" />
        <span>Billing</span>
        <Separator orientation="vertical" />
        <span>Connections</span>
      </div>
    </div>
  ),
};

export const Vertical: Story = {
  render: () => (
    <div className="flex h-8 items-center gap-4 text-sm">
      <span>12 projects</span>
      <Separator orientation="vertical" />
      <span>4 members</span>
      <Separator orientation="vertical" />
      <span>8 connections</span>
    </div>
  ),
};
