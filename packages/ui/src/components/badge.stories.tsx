import type { Meta, StoryObj } from "@storybook/react-vite";
import { CheckCircle, Plus } from "@untitledui/icons";
import { Badge } from "./badge.tsx";

const meta = {
  title: "Components/Badge",
  component: Badge,
  args: {
    children: "Active",
    variant: "default",
    size: "default",
  },
  argTypes: {
    variant: {
      control: "select",
      options: [
        "default",
        "secondary",
        "destructive",
        "success",
        "warning",
        "outline",
      ],
    },
    size: {
      control: "select",
      options: ["default", "icon"],
    },
  },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Variants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Badge>Default</Badge>
      <Badge variant="secondary">Draft</Badge>
      <Badge variant="destructive">Failed</Badge>
      <Badge variant="success">Connected</Badge>
      <Badge variant="warning">Pending review</Badge>
      <Badge variant="outline">Read only</Badge>
    </div>
  ),
};

export const WithIcon: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="success">
        <CheckCircle /> Verified
      </Badge>
      <Badge size="icon" aria-label="Add tag">
        <Plus />
      </Badge>
    </div>
  ),
};

export const StatusRow: Story = {
  render: () => (
    <div className="flex items-center gap-3 text-sm">
      <span className="text-foreground">production-db</span>
      <Badge variant="success">Healthy</Badge>
      <span className="text-foreground">staging-db</span>
      <Badge variant="warning">Degraded</Badge>
      <span className="text-foreground">legacy-api</span>
      <Badge variant="destructive">Offline</Badge>
    </div>
  ),
};
