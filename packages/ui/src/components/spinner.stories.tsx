import type { Meta, StoryObj } from "@storybook/react-vite";
import { Spinner } from "./spinner.tsx";

const meta = {
  title: "Atoms/Spinner",
  component: Spinner,
  args: {
    size: "default",
  },
  argTypes: {
    size: {
      control: "select",
      options: ["2xs", "xs", "sm", "default", "lg", "icon"],
    },
  },
} satisfies Meta<typeof Spinner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** Takes the colour of the text around it. */
export const Colors: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <Spinner />
      <Spinner className="text-secondary" />
      <Spinner className="text-destructive" />
      <Spinner className="text-success" />
      <Spinner className="text-special" />
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <Spinner size="2xs" />
      <Spinner size="xs" />
      <Spinner size="sm" />
      <Spinner size="default" />
      <Spinner size="lg" />
    </div>
  ),
};

/** Inside a filled button. */
export const OnFilledButton: Story = {
  render: () => (
    <button
      type="button"
      className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
    >
      <Spinner size="xs" />
      Saving
    </button>
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
