import type { Meta, StoryObj } from "@storybook/react-vite";
import { Label } from "./label.tsx";
import { RadioGroup, RadioGroupItem } from "./radio-group.tsx";

const meta = {
  title: "Components/RadioGroup",
  component: RadioGroup,
} satisfies Meta<typeof RadioGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <RadioGroup defaultValue="member">
      <div className="flex items-center gap-2">
        <RadioGroupItem value="admin" id="role-admin" />
        <Label htmlFor="role-admin">Admin</Label>
      </div>
      <div className="flex items-center gap-2">
        <RadioGroupItem value="member" id="role-member" />
        <Label htmlFor="role-member">Member</Label>
      </div>
      <div className="flex items-center gap-2">
        <RadioGroupItem value="viewer" id="role-viewer" />
        <Label htmlFor="role-viewer">Viewer</Label>
      </div>
    </RadioGroup>
  ),
};

export const WithDescriptions: Story = {
  render: () => (
    <RadioGroup defaultValue="private" className="w-80">
      <div className="flex items-start gap-2">
        <RadioGroupItem value="private" id="vis-private" className="mt-0.5" />
        <div className="grid gap-1">
          <Label htmlFor="vis-private">Private</Label>
          <p className="text-sm text-muted-foreground">
            Only members of this project can access it.
          </p>
        </div>
      </div>
      <div className="flex items-start gap-2">
        <RadioGroupItem value="internal" id="vis-internal" className="mt-0.5" />
        <div className="grid gap-1">
          <Label htmlFor="vis-internal">Internal</Label>
          <p className="text-sm text-muted-foreground">
            Anyone in the organization can view this project.
          </p>
        </div>
      </div>
      <div className="flex items-start gap-2">
        <RadioGroupItem value="public" id="vis-public" className="mt-0.5" />
        <div className="grid gap-1">
          <Label htmlFor="vis-public">Public</Label>
          <p className="text-sm text-muted-foreground">
            Anyone with the link can view this project.
          </p>
        </div>
      </div>
    </RadioGroup>
  ),
};

export const Disabled: Story = {
  render: () => (
    <RadioGroup defaultValue="monthly" disabled>
      <div className="flex items-center gap-2">
        <RadioGroupItem value="monthly" id="bill-monthly" />
        <Label htmlFor="bill-monthly">Monthly billing</Label>
      </div>
      <div className="flex items-center gap-2">
        <RadioGroupItem value="yearly" id="bill-yearly" />
        <Label htmlFor="bill-yearly">Yearly billing</Label>
      </div>
    </RadioGroup>
  ),
};

export const Horizontal: Story = {
  render: () => (
    <RadioGroup defaultValue="system" className="grid-flow-col">
      <div className="flex items-center gap-2">
        <RadioGroupItem value="light" id="theme-light" />
        <Label htmlFor="theme-light">Light</Label>
      </div>
      <div className="flex items-center gap-2">
        <RadioGroupItem value="dark" id="theme-dark" />
        <Label htmlFor="theme-dark">Dark</Label>
      </div>
      <div className="flex items-center gap-2">
        <RadioGroupItem value="system" id="theme-system" />
        <Label htmlFor="theme-system">System</Label>
      </div>
    </RadioGroup>
  ),
};
