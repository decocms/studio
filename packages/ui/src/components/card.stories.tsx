import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArrowRight, DotsVertical } from "@untitledui/icons";
import { Button } from "./button.tsx";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./card.tsx";

const meta = {
  title: "Components/Card",
  component: Card,
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Card className="w-80 py-6">
      <CardHeader>
        <CardTitle>Project settings</CardTitle>
        <CardDescription>
          Manage how this project appears across your organization.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-6 text-sm text-muted-foreground">
        Changes apply to all members with access to this project.
      </CardContent>
    </Card>
  ),
};

export const WithAction: Story = {
  render: () => (
    <Card className="w-80 py-6">
      <CardHeader>
        <CardTitle>Slack connection</CardTitle>
        <CardDescription>Connected 3 days ago by Ana Souza</CardDescription>
        <CardAction>
          <Button variant="ghost" size="icon" aria-label="More options">
            <DotsVertical />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="px-6 text-sm text-muted-foreground">
        12 tools exposed. Last used 2 hours ago.
      </CardContent>
    </Card>
  ),
};

export const WithFooter: Story = {
  render: () => (
    <Card className="w-80 py-6">
      <CardHeader>
        <CardTitle>Invite your team</CardTitle>
        <CardDescription>
          Members you invite can view and run tools in this workspace.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-6 text-sm text-muted-foreground">
        You have 4 of 10 seats in use on the current plan.
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Button variant="outline">Skip for now</Button>
        <Button>
          Invite members <ArrowRight />
        </Button>
      </CardFooter>
    </Card>
  ),
};
