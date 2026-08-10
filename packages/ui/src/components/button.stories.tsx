import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArrowRight, Plus, Trash01 } from "@untitledui/icons";
import { Button } from "./button.tsx";

const meta = {
  title: "Components/Button",
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
