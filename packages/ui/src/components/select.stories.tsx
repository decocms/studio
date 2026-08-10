import type { Meta, StoryObj } from "@storybook/react-vite";
import { Label } from "./label.tsx";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./select.tsx";

const meta = {
  title: "Components/Select",
  component: Select,
} satisfies Meta<typeof Select>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Select>
      <SelectTrigger className="w-56">
        <SelectValue placeholder="Select a role" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="admin">Admin</SelectItem>
        <SelectItem value="member">Member</SelectItem>
        <SelectItem value="viewer">Viewer</SelectItem>
      </SelectContent>
    </Select>
  ),
};

export const WithGroups: Story = {
  render: () => (
    <div className="grid gap-2">
      <Label htmlFor="model">Default model</Label>
      <Select defaultValue="claude-sonnet">
        <SelectTrigger id="model" className="w-64">
          <SelectValue placeholder="Select a model" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Anthropic</SelectLabel>
            <SelectItem value="claude-opus">Claude Opus</SelectItem>
            <SelectItem value="claude-sonnet">Claude Sonnet</SelectItem>
            <SelectItem value="claude-haiku">Claude Haiku</SelectItem>
          </SelectGroup>
          <SelectSeparator />
          <SelectGroup>
            <SelectLabel>OpenAI</SelectLabel>
            <SelectItem value="gpt-5">GPT-5</SelectItem>
            <SelectItem value="gpt-5-mini">GPT-5 mini</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Select defaultValue="production">
        <SelectTrigger size="xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="production">Production</SelectItem>
          <SelectItem value="staging">Staging</SelectItem>
        </SelectContent>
      </Select>
      <Select defaultValue="production">
        <SelectTrigger size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="production">Production</SelectItem>
          <SelectItem value="staging">Staging</SelectItem>
        </SelectContent>
      </Select>
      <Select defaultValue="production">
        <SelectTrigger size="default">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="production">Production</SelectItem>
          <SelectItem value="staging">Staging</SelectItem>
        </SelectContent>
      </Select>
    </div>
  ),
};

export const Disabled: Story = {
  render: () => (
    <Select defaultValue="us-east" disabled>
      <SelectTrigger className="w-56">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="us-east">US East (managed by plan)</SelectItem>
      </SelectContent>
    </Select>
  ),
};

export const WithDisabledItem: Story = {
  render: () => (
    <Select>
      <SelectTrigger className="w-56">
        <SelectValue placeholder="Select a plan" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="free">Free</SelectItem>
        <SelectItem value="pro">Pro</SelectItem>
        <SelectItem value="enterprise" disabled>
          Enterprise (contact sales)
        </SelectItem>
      </SelectContent>
    </Select>
  ),
};
