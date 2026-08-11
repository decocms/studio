import type { Meta, StoryObj } from "@storybook/react-vite";
import { Label } from "./label.tsx";
import { Switch } from "./switch.tsx";

const meta = {
  title: "Components/Switch",
  component: Switch,
} satisfies Meta<typeof Switch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { "aria-label": "Toggle setting" },
};

export const WithLabel: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Switch id="airplane" />
      <Label htmlFor="airplane">Enable notifications</Label>
    </div>
  ),
};

export const States: Story = {
  render: () => (
    <div className="grid gap-3">
      <div className="flex items-center gap-2">
        <Switch id="off" />
        <Label htmlFor="off">Off</Label>
      </div>
      <div className="flex items-center gap-2">
        <Switch id="on" defaultChecked />
        <Label htmlFor="on">On</Label>
      </div>
      <div className="flex items-center gap-2">
        <Switch id="disabled-off" disabled />
        <Label htmlFor="disabled-off">Disabled off</Label>
      </div>
      <div className="flex items-center gap-2">
        <Switch id="disabled-on" disabled defaultChecked />
        <Label htmlFor="disabled-on">Disabled on</Label>
      </div>
    </div>
  ),
};

export const SettingsRow: Story = {
  render: () => (
    <div className="grid w-96 gap-4">
      <div className="flex items-center justify-between gap-4">
        <div className="grid gap-1">
          <Label htmlFor="tracing">Distributed tracing</Label>
          <p className="text-sm text-muted-foreground">
            Record a trace for every tool call in this project.
          </p>
        </div>
        <Switch id="tracing" defaultChecked />
      </div>
      <div className="flex items-center justify-between gap-4">
        <div className="grid gap-1">
          <Label htmlFor="audit">Audit logging</Label>
          <p className="text-sm text-muted-foreground">
            Keep a log of member and connection changes.
          </p>
        </div>
        <Switch id="audit" defaultChecked />
      </div>
      <div className="flex items-center justify-between gap-4">
        <div className="grid gap-1">
          <Label htmlFor="beta">Beta features</Label>
          <p className="text-sm text-muted-foreground">
            Try new features before they roll out to everyone.
          </p>
        </div>
        <Switch id="beta" />
      </div>
    </div>
  ),
};
