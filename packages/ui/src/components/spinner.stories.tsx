import type { Meta, StoryObj } from "@storybook/react-vite";
import { Spinner } from "./spinner.tsx";

const meta = {
  title: "Components/Spinner",
  component: Spinner,
  args: {
    variant: "default",
    size: "default",
  },
  argTypes: {
    variant: {
      control: "select",
      options: ["default", "destructive", "secondary", "success", "special"],
    },
    size: {
      control: "select",
      options: ["default", "sm", "xs", "lg", "icon"],
    },
  },
} satisfies Meta<typeof Spinner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Variants: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <Spinner variant="default" />
      <Spinner variant="secondary" />
      <Spinner variant="destructive" />
      <Spinner variant="success" />
      <Spinner variant="special" />
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <Spinner size="xs" />
      <Spinner size="sm" />
      <Spinner size="default" />
      <Spinner size="lg" />
    </div>
  ),
};

export const LoadingState: Story = {
  render: () => (
    <div className="flex items-center gap-3 text-sm text-muted-foreground">
      <Spinner size="xs" />
      Syncing connections...
    </div>
  ),
};
