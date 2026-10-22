import type { Meta, StoryObj } from "@storybook/react-vite";
import { File02, Settings01 } from "@untitledui/icons";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs.tsx";
import { Matrix } from "../foundations/kit.tsx";

const meta = {
  title: "Molecules/Tabs",
  component: Tabs,
  args: {
    variant: "pill",
  },
  argTypes: {
    variant: {
      control: "select",
      options: ["pill", "underline", "canvas"],
    },
  },
} satisfies Meta<typeof Tabs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Tabs defaultValue="general" className="w-96">
      <TabsList className="w-full">
        <TabsTrigger value="general">General</TabsTrigger>
        <TabsTrigger value="members">Members</TabsTrigger>
        <TabsTrigger value="billing">Billing</TabsTrigger>
      </TabsList>
      <TabsContent value="general" className="text-sm text-muted-foreground">
        Update your organization name, logo, and default preferences.
      </TabsContent>
      <TabsContent value="members" className="text-sm text-muted-foreground">
        Invite teammates and manage their roles.
      </TabsContent>
      <TabsContent value="billing" className="text-sm text-muted-foreground">
        View invoices and change your plan.
      </TabsContent>
    </Tabs>
  ),
};

export const Underline: Story = {
  render: () => (
    <Tabs defaultValue="overview" variant="underline" className="w-96">
      <TabsList variant="underline">
        <TabsTrigger variant="underline" value="overview">
          Overview
        </TabsTrigger>
        <TabsTrigger variant="underline" value="activity">
          Activity
        </TabsTrigger>
        <TabsTrigger variant="underline" value="settings">
          Settings
        </TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="text-sm text-muted-foreground">
        Recent activity and usage for this connection.
      </TabsContent>
      <TabsContent value="activity" className="text-sm text-muted-foreground">
        Tool calls made through this connection in the last 30 days.
      </TabsContent>
      <TabsContent value="settings" className="text-sm text-muted-foreground">
        Configure authentication and access policies.
      </TabsContent>
    </Tabs>
  ),
};

export const Canvas: Story = {
  render: () => (
    <Tabs defaultValue="readme" variant="canvas" className="w-96">
      <TabsList variant="canvas" className="w-full">
        <TabsTrigger variant="canvas" value="readme">
          <File02 className="size-4" /> README.md
        </TabsTrigger>
        <TabsTrigger variant="canvas" value="config">
          <Settings01 className="size-4" /> config.json
        </TabsTrigger>
      </TabsList>
      <TabsContent value="readme" className="p-4 text-sm text-muted-foreground">
        Getting started guide for the project.
      </TabsContent>
      <TabsContent value="config" className="p-4 text-sm text-muted-foreground">
        Runtime configuration for the MCP server.
      </TabsContent>
    </Tabs>
  ),
};

export const Disabled: Story = {
  render: () => (
    <Tabs defaultValue="general" className="w-96">
      <TabsList className="w-full">
        <TabsTrigger value="general">General</TabsTrigger>
        <TabsTrigger value="advanced" disabled>
          Advanced
        </TabsTrigger>
      </TabsList>
      <TabsContent value="general" className="text-sm text-muted-foreground">
        Advanced settings require an admin role.
      </TabsContent>
    </Tabs>
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
      rows={[
        {
          label: "Tabs",
          cells: ["", "is-hover", "is-focus"].map((state) => (
            <Tabs key={state} defaultValue="preview">
              <TabsList>
                <TabsTrigger value="preview">Preview</TabsTrigger>
                <TabsTrigger value="code" className={state}>
                  Code
                </TabsTrigger>
                <TabsTrigger value="content">Content</TabsTrigger>
              </TabsList>
            </Tabs>
          )),
        },
      ]}
    />
  ),
};
