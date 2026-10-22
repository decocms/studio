import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArrowRight, Plus, Trash01 } from "@untitledui/icons";
import { AgentAvatar } from "./agent-avatar.tsx";
import { Button } from "./button.tsx";
import { Matrix } from "../foundations/kit.tsx";

const meta = {
  title: "Atoms/Button",
  component: Button,
  args: {
    children: "Button",
    variant: "default",
    size: "default",
  },
  argTypes: {
    variant: {
      control: "select",
      options: [
        "default",
        "secondary",
        "outline",
        "ghost",
        "destructive",
        "success",
        "warning",
        "special",
        "link",
      ],
    },
    size: {
      control: "select",
      options: ["default", "sm", "xs", "lg", "icon"],
    },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Variants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Button>Default</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="outline">Outline</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="destructive">Destructive</Button>
      <Button variant="success">Success</Button>
      <Button variant="warning">Warning</Button>
      <Button variant="brand">Brand</Button>
      <Button variant="special">Special</Button>
      <Button variant="link">Link</Button>
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="xs">Extra small</Button>
      <Button size="sm">Small</Button>
      <Button size="default">Default</Button>
      <Button size="lg">Large</Button>
      <Button size="icon" aria-label="Add">
        <Plus />
      </Button>
    </div>
  ),
};

export const WithIcon: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Button>
        <Plus /> New item
      </Button>
      <Button variant="outline">
        Continue <ArrowRight />
      </Button>
      <Button variant="destructive">
        <Trash01 /> Delete
      </Button>
    </div>
  ),
};

export const Disabled: Story = {
  args: { disabled: true },
};

const AGENT_FACE =
  "https://assets.decocache.com/decocms/fd07a578-6b1c-40f1-bc05-88a3b981695d/f7fc4ffa81aec04e37ae670c3cd4936643a7b269.png";

export const Agent: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Button variant="agent" size="sm">
        <AgentAvatar src={AGENT_FACE} size={20} /> Ask
      </Button>
      <Button variant="agent">
        <AgentAvatar src={AGENT_FACE} size={26} /> Ask
      </Button>
      <Button variant="agent" size="lg">
        <AgentAvatar src={AGENT_FACE} size={32} /> Ask
      </Button>
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
      columns={["Default", "Hover", "Focus", "Pressed", "Disabled"]}
      proposed={["Pressed"]}
      rows={(
        [
          "default",
          "secondary",
          "outline",
          "ghost",
          "destructive",
          "brand",
          "agent",
        ] as const
      ).map((variant) => ({
        label: variant === "default" ? "primary" : variant,
        cells: ["", "is-hover", "is-focus", "is-active", "disabled"].map(
          (state) => (
            <Button
              key={state}
              variant={variant}
              className={state}
              disabled={state === "disabled"}
            >
              {variant === "agent" ? (
                <>
                  <AgentAvatar src={AGENT_FACE} size={26} /> Ask
                </>
              ) : (
                "New task"
              )}
            </Button>
          ),
        ),
      }))}
    />
  ),
};

export const SizesMatrix: Story = {
  name: "Sizes · 28 / 32 / 40",
  parameters: { controls: { disable: true }, layout: "padded" },
  render: () => (
    <Matrix
      columns={["sm · 28", "default · 32", "lg · 40"]}
      rows={(["default", "secondary", "outline"] as const).map((variant) => ({
        label: variant === "default" ? "primary" : variant,
        cells: (["sm", "default", "lg"] as const).map((size) => (
          <Button key={size} variant={variant} size={size}>
            <Plus /> New task
          </Button>
        )),
      }))}
    />
  ),
};
