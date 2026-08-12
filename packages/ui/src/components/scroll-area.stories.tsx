import type { Meta, StoryObj } from "@storybook/react-vite";
import { ScrollArea, ScrollBar } from "./scroll-area.tsx";
import { Separator } from "./separator.tsx";

const meta = {
  title: "Components/ScrollArea",
  component: ScrollArea,
} satisfies Meta<typeof ScrollArea>;

export default meta;
type Story = StoryObj<typeof meta>;

const events = [
  "Ana Souza invited Bruno Lima",
  "Slack connection created",
  "API key rotated",
  "Project Storefront redesign archived",
  "Bruno Lima changed role to Admin",
  "GitHub connection re-authenticated",
  "Webhook delivery failed (retrying)",
  "Monthly usage report generated",
  "New agent Checkout helper deployed",
  "Postgres connection updated",
  "Carla Mendes joined the organization",
  "Audit log export completed",
];

export const Default: Story = {
  render: () => (
    <ScrollArea className="h-64 w-80 rounded-md border border-border">
      <div className="p-4">
        <h4 className="mb-4 text-sm font-medium">Recent activity</h4>
        {events.map((event) => (
          <div key={event}>
            <div className="py-2 text-sm">{event}</div>
            <Separator />
          </div>
        ))}
      </div>
    </ScrollArea>
  ),
};

export const Horizontal: Story = {
  render: () => (
    <ScrollArea className="w-80 rounded-md border border-border whitespace-nowrap">
      <div className="flex gap-4 p-4">
        {[
          "Storefront redesign",
          "Checkout experiments",
          "Internal admin tools",
          "Marketing site",
          "Data pipeline",
          "Mobile app",
        ].map((project) => (
          <div
            key={project}
            className="flex h-24 w-40 shrink-0 items-center justify-center rounded-md bg-muted text-sm text-muted-foreground"
          >
            {project}
          </div>
        ))}
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  ),
};

export const HiddenScrollbar: Story = {
  render: () => (
    <ScrollArea
      hideScrollbar
      className="h-48 w-80 rounded-md border border-border"
    >
      <div className="space-y-2 p-4 text-sm">
        {events.map((event) => (
          <p key={event}>{event}</p>
        ))}
      </div>
    </ScrollArea>
  ),
};
