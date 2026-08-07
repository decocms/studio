import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChevronDown, Copy01, SearchMd } from "@untitledui/icons";
import { Button } from "./button.tsx";
import {
  ButtonGroup,
  ButtonGroupSeparator,
  ButtonGroupText,
} from "./button-group.tsx";
import { Input } from "./input.tsx";

const meta = {
  title: "Components/ButtonGroup",
  component: ButtonGroup,
  args: {
    orientation: "horizontal",
  },
  argTypes: {
    orientation: {
      control: "select",
      options: ["horizontal", "vertical"],
    },
  },
} satisfies Meta<typeof ButtonGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <ButtonGroup {...args}>
      <Button variant="outline">Day</Button>
      <Button variant="outline">Week</Button>
      <Button variant="outline">Month</Button>
    </ButtonGroup>
  ),
};

export const Vertical: Story = {
  render: () => (
    <ButtonGroup orientation="vertical">
      <Button variant="outline">Move up</Button>
      <Button variant="outline">Move down</Button>
      <Button variant="outline">Remove</Button>
    </ButtonGroup>
  ),
};

export const WithSeparator: Story = {
  render: () => (
    <ButtonGroup>
      <Button variant="outline">Save changes</Button>
      <ButtonGroupSeparator />
      <Button variant="outline" size="icon" aria-label="More save options">
        <ChevronDown />
      </Button>
    </ButtonGroup>
  ),
};

export const WithText: Story = {
  render: () => (
    <ButtonGroup>
      <ButtonGroupText>https://</ButtonGroupText>
      <Input placeholder="acme.deco.page" className="w-56" />
      <Button variant="outline" aria-label="Copy URL">
        <Copy01 /> Copy
      </Button>
    </ButtonGroup>
  ),
};

export const WithInput: Story = {
  render: () => (
    <ButtonGroup>
      <Input placeholder="Search members..." className="w-64" />
      <Button variant="outline" aria-label="Search">
        <SearchMd />
      </Button>
    </ButtonGroup>
  ),
};
