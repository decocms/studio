import { Grid01, List } from "@untitledui/icons";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold01,
  Italic01,
  Underline01,
} from "@untitledui/icons";
import { ToggleGroup, ToggleGroupItem } from "./toggle-group.tsx";
import { Matrix } from "../foundations/kit.tsx";

const meta = {
  title: "Molecules/ToggleGroup",
  component: ToggleGroup,
  args: {
    type: "multiple",
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
} satisfies Meta<typeof ToggleGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <ToggleGroup {...args}>
      <ToggleGroupItem value="bold" aria-label="Toggle bold">
        <Bold01 />
      </ToggleGroupItem>
      <ToggleGroupItem value="italic" aria-label="Toggle italic">
        <Italic01 />
      </ToggleGroupItem>
      <ToggleGroupItem value="underline" aria-label="Toggle underline">
        <Underline01 />
      </ToggleGroupItem>
    </ToggleGroup>
  ),
};

export const SingleSelection: Story = {
  render: () => (
    <ToggleGroup type="single" defaultValue="left" variant="outline">
      <ToggleGroupItem value="left" aria-label="Align left">
        <AlignLeft />
      </ToggleGroupItem>
      <ToggleGroupItem value="center" aria-label="Align center">
        <AlignCenter />
      </ToggleGroupItem>
      <ToggleGroupItem value="right" aria-label="Align right">
        <AlignRight />
      </ToggleGroupItem>
    </ToggleGroup>
  ),
};

export const Outline: Story = {
  render: () => (
    <ToggleGroup type="single" defaultValue="month" variant="outline">
      <ToggleGroupItem value="day">Day</ToggleGroupItem>
      <ToggleGroupItem value="week">Week</ToggleGroupItem>
      <ToggleGroupItem value="month">Month</ToggleGroupItem>
    </ToggleGroup>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-4">
      <ToggleGroup type="single" size="sm" variant="outline">
        <ToggleGroupItem value="list">List</ToggleGroupItem>
        <ToggleGroupItem value="grid">Grid</ToggleGroupItem>
      </ToggleGroup>
      <ToggleGroup type="single" size="default" variant="outline">
        <ToggleGroupItem value="list">List</ToggleGroupItem>
        <ToggleGroupItem value="grid">Grid</ToggleGroupItem>
      </ToggleGroup>
      <ToggleGroup type="single" size="lg" variant="outline">
        <ToggleGroupItem value="list">List</ToggleGroupItem>
        <ToggleGroupItem value="grid">Grid</ToggleGroupItem>
      </ToggleGroup>
    </div>
  ),
};

export const Disabled: Story = {
  render: () => (
    <ToggleGroup type="multiple" variant="outline" disabled>
      <ToggleGroupItem value="bold">Bold</ToggleGroupItem>
      <ToggleGroupItem value="italic">Italic</ToggleGroupItem>
    </ToggleGroup>
  ),
};

export const Segmented: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-3">
      <ToggleGroup type="single" variant="segmented" defaultValue="preview">
        <ToggleGroupItem value="preview">Preview</ToggleGroupItem>
        <ToggleGroupItem value="code">Code</ToggleGroupItem>
      </ToggleGroup>
      <ToggleGroup
        type="single"
        variant="segmented"
        size="sm"
        defaultValue="all"
      >
        <ToggleGroupItem value="all">All</ToggleGroupItem>
        <ToggleGroupItem value="dev">Dev</ToggleGroupItem>
        <ToggleGroupItem value="content">Content</ToggleGroupItem>
        <ToggleGroupItem value="design">Design</ToggleGroupItem>
      </ToggleGroup>
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
      columns={["Default", "Hover on Code", "Focus on Code"]}
      rows={(["default", "sm"] as const).map((size) => ({
        label: `segmented · ${size === "sm" ? 28 : 32}`,
        cells: ["", "is-hover", "is-focus"].map((state) => (
          <ToggleGroup
            key={state}
            type="single"
            variant="segmented"
            size={size}
            defaultValue="preview"
          >
            <ToggleGroupItem value="preview">Preview</ToggleGroupItem>
            <ToggleGroupItem value="code" className={state}>
              Code
            </ToggleGroupItem>
          </ToggleGroup>
        )),
      }))}
    />
  ),
};

/** Icon-only options, e.g. a view switch: the tooltip names each one. */
export const Icons: Story = {
  render: () => (
    <ToggleGroup
      type="single"
      variant="segmented"
      size="sm"
      defaultValue="grid"
    >
      <ToggleGroupItem value="grid" tooltip="Grid view">
        <Grid01 />
      </ToggleGroupItem>
      <ToggleGroupItem value="list" tooltip="List view">
        <List />
      </ToggleGroupItem>
    </ToggleGroup>
  ),
};

/** Icon and label together keep their padding, like a page's view switch. */
export const IconAndLabel: Story = {
  render: () => (
    <ToggleGroup
      type="single"
      variant="segmented"
      size="sm"
      defaultValue="project"
    >
      <ToggleGroupItem value="project">
        <Grid01 /> Project
      </ToggleGroupItem>
      <ToggleGroupItem value="files">
        <List /> Files
      </ToggleGroupItem>
    </ToggleGroup>
  ),
};
