import type { Meta, StoryObj } from "@storybook/react-vite";
import { Label } from "./label.tsx";
import { Textarea } from "./textarea.tsx";

const meta = {
  title: "Components/Textarea",
  component: Textarea,
  args: {
    placeholder: "Describe what this connection is used for...",
  },
} satisfies Meta<typeof Textarea>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <div className="w-96">
      <Textarea {...args} />
    </div>
  ),
};

export const WithLabel: Story = {
  render: () => (
    <div className="grid w-96 gap-2">
      <Label htmlFor="description">Project description</Label>
      <Textarea
        id="description"
        placeholder="A short summary shown on the project card."
      />
      <p className="text-sm text-muted-foreground">
        Visible to every member of the organization.
      </p>
    </div>
  ),
};

export const WithContent: Story = {
  render: () => (
    <div className="w-96">
      <Textarea defaultValue="Handles order lookups and refund requests for the storefront. Escalates anything involving payments to a human agent." />
    </div>
  ),
};

export const Invalid: Story = {
  render: () => (
    <div className="grid w-96 gap-2">
      <Label htmlFor="prompt">System prompt</Label>
      <Textarea id="prompt" aria-invalid defaultValue="" />
      <p className="text-sm text-destructive">A system prompt is required.</p>
    </div>
  ),
};

export const Disabled: Story = {
  args: {
    disabled: true,
    value: "This field is managed by your organization admin.",
  },
  render: (args) => (
    <div className="w-96">
      <Textarea {...args} />
    </div>
  ),
};
