import type { Meta, StoryObj } from "@storybook/react-vite";
import { Avatar } from "./avatar.tsx";
import { Button } from "./button.tsx";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "./hover-card.tsx";

const meta = {
  title: "Components/HoverCard",
  component: HoverCard,
} satisfies Meta<typeof HoverCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <HoverCard>
      <HoverCardTrigger asChild>
        <Button variant="link">@ana.souza</Button>
      </HoverCardTrigger>
      <HoverCardContent className="w-72">
        <div className="flex gap-4">
          <Avatar fallback="Ana Souza" />
          <div className="grid gap-1">
            <h4 className="text-sm font-semibold">Ana Souza</h4>
            <p className="text-sm">
              Platform engineer. Maintains the payments and checkout
              connections.
            </p>
            <span className="text-muted-foreground text-xs">
              Joined December 2024
            </span>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  ),
};

export const PlainTextTrigger: Story = {
  render: () => (
    <p className="max-w-md text-sm">
      The nightly sync failed because the{" "}
      <HoverCard>
        <HoverCardTrigger className="cursor-pointer font-medium underline underline-offset-4">
          Stripe connection
        </HoverCardTrigger>
        <HoverCardContent>
          <div className="grid gap-1">
            <h4 className="text-sm font-semibold">Stripe</h4>
            <p className="text-muted-foreground text-sm">
              OAuth connection, 14 tools exposed. Last used 2 hours ago by the
              billing agent.
            </p>
          </div>
        </HoverCardContent>
      </HoverCard>{" "}
      token expired.
    </p>
  ),
};
