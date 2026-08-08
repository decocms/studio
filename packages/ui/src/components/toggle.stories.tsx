import type { Meta, StoryObj } from "@storybook/react-vite";
import { Bold01, Italic01, Underline01 } from "@untitledui/icons";
import { Toggle } from "./toggle.tsx";

const meta = {
  title: "Components/Toggle",
  component: Toggle,
  args: {
    children: "Bold",
    variant: "default",
    size: "default",
  },
  argTypes: {
    variant: {
      control: "select",
      options: ["default", "outline"],
    },
    size: {
      control: "select",
      options: ["default", "sm", "lg"],
    },
  },
} satisfies Meta<typeof Toggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Variants: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Toggle aria-label="Toggle bold">
        <Bold01 /> Bold
      </Toggle>
      <Toggle variant="outline" aria-label="Toggle italic">
        <Italic01 /> Italic
      </Toggle>
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Toggle size="sm" variant="outline">
        Small
      </Toggle>
      <Toggle size="default" variant="outline">
        Default
      </Toggle>
      <Toggle size="lg" variant="outline">
        Large
      </Toggle>
    </div>
  ),
};

export const Pressed: Story = {
  args: {
    defaultPressed: true,
    children: (
      <>
        <Underline01 /> Underline
      </>
    ),
  },
};

export const Disabled: Story = {
  args: { disabled: true, children: "Unavailable" },
};
