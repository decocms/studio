import type { Meta, StoryObj } from "@storybook/react-vite";
import { Bold01, Italic01, Underline01 } from "@untitledui/icons";
import { Toggle } from "./toggle.tsx";
import { Matrix } from "../foundations/kit.tsx";

const meta = {
  title: "Atoms/Toggle",
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
      rows={(["default", "outline"] as const).map((variant) => ({
        label: variant,
        cells: ["", "is-hover", "is-focus", "pressed", "disabled"].map(
          (state) => (
            <Toggle
              key={state}
              variant={variant}
              className={state}
              pressed={state === "pressed"}
              disabled={state === "disabled"}
              aria-label="Bold"
            >
              <Bold01 /> Bold
            </Toggle>
          ),
        ),
      }))}
    />
  ),
};
