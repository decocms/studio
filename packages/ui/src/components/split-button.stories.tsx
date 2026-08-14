import type { Meta, StoryObj } from "@storybook/react-vite";
import { GitBranch01 } from "@untitledui/icons";
import { SplitButton, type SplitButtonMenuItem } from "./split-button.tsx";

const items: SplitButtonMenuItem[] = [
  { key: "review", label: "Request review", onSelect: () => {} },
  { key: "draft", label: "Convert to draft", onSelect: () => {} },
  {
    key: "force",
    label: "Force publish",
    disabled: true,
    tooltip: "Only maintainers can force publish",
    onSelect: () => {},
  },
];

const meta = {
  title: "Components/SplitButton",
  component: SplitButton,
  args: {
    label: "Publish to main",
    menuAriaLabel: "More publish options",
    variant: "default",
    size: "default",
    items,
    onClick: () => {},
  },
  argTypes: {
    variant: {
      control: "select",
      options: [
        "default",
        "secondary",
        "outline",
        "destructive",
        "success",
        "warning",
        "brand",
        "special",
      ],
    },
    size: {
      control: "select",
      options: ["xs", "sm", "default", "lg", "xl"],
    },
  },
} satisfies Meta<typeof SplitButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** No `items` — the chevron half is not rendered, leaving a plain button. */
export const WithoutMenu: Story = {
  args: { items: [] },
};

/** The primary action is unavailable, but the menu still offers alternatives. */
export const DisabledPrimaryWithMenu: Story = {
  args: {
    label: "Up to date",
    disabled: true,
    tooltip: "There is nothing new to publish",
  },
};

export const Loading: Story = {
  args: { label: "Publishing", loading: true },
};

/** Brightness breathes; under `prefers-reduced-motion` it dims statically. */
export const Pulse: Story = {
  args: { pulse: true, variant: "brand" },
};

export const WithIcon: Story = {
  args: { icon: <GitBranch01 /> },
};

export const Variants: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-2">
      <SplitButton {...args} variant="brand" label="Publish" />
      <SplitButton {...args} variant="warning" label="Republish" />
      <SplitButton {...args} variant="outline" label="Export" />
      <SplitButton {...args} variant="default" label="Save" />
    </div>
  ),
};

export const Sizes: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-2">
      <SplitButton {...args} size="xs" label="Extra small" />
      <SplitButton {...args} size="sm" label="Small" />
      <SplitButton {...args} size="default" label="Default" />
      <SplitButton {...args} size="lg" label="Large" />
    </div>
  ),
};
