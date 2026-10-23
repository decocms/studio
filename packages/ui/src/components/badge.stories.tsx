import type { Meta, StoryObj } from "@storybook/react-vite";
import { CheckCircle, Plus } from "@untitledui/icons";
import { Badge, BadgeDot } from "./badge.tsx";
import { Matrix } from "../foundations/kit.tsx";

const meta = {
  title: "Atoms/Badge",
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
        "success",
        "warning",
        "destructive",
        "agent",
        "lime",
        "info",
        "outline",
        "muted",
      ],
    },
    size: {
      control: "select",
      options: ["sm", "default", "lg", "icon"],
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
      <Badge variant="success">On track</Badge>
      <Badge variant="warning">Behind</Badge>
      <Badge variant="destructive">Needs attention</Badge>
      <Badge variant="agent">Agent proposal</Badge>
      <Badge variant="lime">Live</Badge>
      <Badge variant="info">Info</Badge>
      <Badge variant="outline">Checkout</Badge>
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className="flex flex-col gap-2">
      {(["sm", "default", "lg"] as const).map((size) => (
        <div key={size} className="flex items-center gap-2">
          <Badge size={size}>14</Badge>
          <Badge size={size} variant="success">
            <BadgeDot /> Working
          </Badge>
          <Badge size={size} variant="warning">
            <BadgeDot /> Behind
          </Badge>
          <Badge size={size} variant="outline">
            merged
          </Badge>
        </div>
      ))}
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

export const Tones: Story = {
  parameters: { controls: { disable: true }, layout: "padded" },
  render: () => (
    <Matrix
      columns={[
        "sm · 16 · counts",
        "default · 20",
        "lg · 24 · tags",
        "With dot",
      ]}
      rows={(
        [
          ["neutral", "default"],
          ["success", "success"],
          ["warning", "warning"],
          ["error", "destructive"],
          ["agent", "agent"],
          ["lime", "lime"],
          ["info", "info"],
          ["outline", "outline"],
        ] as const
      ).map(([label, variant]) => ({
        label,
        cells: [
          <Badge key="sm" variant={variant} size="sm">
            14
          </Badge>,
          <Badge key="md" variant={variant}>
            On track
          </Badge>,
          <Badge key="lg" variant={variant} size="lg">
            Checkout
          </Badge>,
          <Badge key="dot" variant={variant}>
            <BadgeDot /> Working
          </Badge>,
        ],
      }))}
    />
  ),
};
