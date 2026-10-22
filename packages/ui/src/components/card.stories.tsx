import type { Meta, StoryObj } from "@storybook/react-vite";
import { Globe02, Key01 } from "@untitledui/icons";
import { Matrix } from "../foundations/kit.tsx";
import { Badge, BadgeDot } from "./badge.tsx";
import { Button } from "./button.tsx";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardInset,
  CardTitle,
} from "./card.tsx";
import { ListRow } from "./list-row.tsx";
import { ProjectIcon } from "./project-icon.tsx";

const meta = {
  title: "Molecules/Cards/Card",
  component: Card,
  args: { size: "default", interactive: false },
  argTypes: {
    size: { control: "inline-radio", options: ["default", "tile", "flush"] },
    interactive: { control: "boolean" },
  },
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: (args) => (
    <Card {...args} className="w-80">
      <CardHeader>
        <CardTitle>API keys</CardTitle>
        <CardDescription>Keys let scripts call Studio for you.</CardDescription>
      </CardHeader>
      <CardContent className="text-muted-foreground">
        2 active keys. The oldest was used 5 days ago.
      </CardContent>
    </Card>
  ),
};

/** A section: title, description and action, then hairline rows. */
export const Section: Story = {
  render: () => (
    <Card className="w-96">
      <CardHeader>
        <CardTitle>API keys</CardTitle>
        <CardDescription>Keys let scripts call Studio for you.</CardDescription>
        <CardAction>
          <Button size="sm" variant="outline">
            New key
          </Button>
        </CardAction>
      </CardHeader>
      <div>
        <ListRow
          variant="divided"
          lead={<Key01 />}
          title="CI deploys"
          meta="Used 2 days ago"
        />
        <ListRow
          variant="divided"
          lead={<Key01 />}
          title="Analytics export"
          meta="Used 5 days ago"
        />
      </div>
    </Card>
  ),
};

/** One thing you open, at tile padding. */
export const Tile: Story = {
  render: () => (
    <Card size="tile" interactive asChild className="w-72">
      <button type="button">
        <div className="flex items-center gap-2.5">
          <ProjectIcon color="blue">
            <Globe02 />
          </ProjectIcon>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            Storefront
          </span>
          <Badge variant="success">
            <BadgeDot /> Live
          </Badge>
        </div>
        <span className="text-meta">Updated 3 hours ago</span>
      </button>
    </Card>
  ),
};

/** Rows that run edge to edge bring their own padding. */
export const Flush: Story = {
  render: () => (
    <Card size="flush" className="divide-border w-80 gap-0 divide-y">
      {["Email digest", "Mentions", "Weekly report"].map((row) => (
        <div key={row} className="px-5 py-3 text-sm">
          {row}
        </div>
      ))}
    </Card>
  ),
};

export const WithFooter: Story = {
  render: () => (
    <Card className="w-96">
      <CardHeader>
        <CardTitle>Invite your team</CardTitle>
        <CardDescription>4 of 10 seats in use.</CardDescription>
      </CardHeader>
      <CardFooter className="justify-end">
        <Button variant="outline">Skip for now</Button>
        <Button>Invite members</Button>
      </CardFooter>
    </Card>
  ),
};

/** A grey well inside a card, never a card inside a card. */
export const Inset: Story = {
  render: () => (
    <Card className="w-96">
      <CardTitle>Webhook</CardTitle>
      <CardInset>
        <code className="font-mono text-xs">POST /hooks/9f2c…/deploy</code>
      </CardInset>
    </Card>
  ),
};

export const States: Story = {
  parameters: {
    controls: { disable: true },
    layout: "padded",
    pseudo: { hover: [".is-hover"], focusVisible: [".is-focus"] },
  },
  render: () => (
    <Matrix
      columns={["Default", "Hover", "Focus"]}
      rows={(["default", "tile"] as const).map((size) => ({
        label: size,
        cells: ["", "is-hover", "is-focus"].map((state) => (
          <Card
            key={state}
            size={size}
            interactive
            asChild
            className={`w-56 ${state}`}
          >
            <button type="button">
              <CardTitle>Storefront</CardTitle>
              <span className="text-meta">Updated 3 hours ago</span>
            </button>
          </Card>
        )),
      }))}
    />
  ),
};
