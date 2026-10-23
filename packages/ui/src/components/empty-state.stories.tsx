import type { Meta, StoryObj } from "@storybook/react-vite";
import { AlertCircle, Plus, SearchMd, Zap } from "@untitledui/icons";
import { AgentAvatar } from "./agent-avatar.tsx";
import { Button } from "./button.tsx";
import { Card, CardHeader, CardTitle } from "./card.tsx";
import { EmptyState } from "./empty-state.tsx";

const AGENT_FACE =
  "https://assets.decocache.com/decocms/fd07a578-6b1c-40f1-bc05-88a3b981695d/f7fc4ffa81aec04e37ae670c3cd4936643a7b269.png";

const meta = {
  title: "Molecules/EmptyState",
  component: EmptyState,
  args: {
    icon: <Zap />,
    title: "No automations yet",
    description:
      "Automations run a prompt on a schedule or when something happens.",
    buttonProps: {
      children: (
        <>
          <Plus /> New automation
        </>
      ),
    },
  },
  argTypes: {
    size: { control: "inline-radio", options: ["page", "inline"] },
    tone: { control: "inline-radio", options: ["default", "error"] },
    icon: { control: false },
    illustration: { control: false },
    buttonProps: { control: false },
    buttonComponent: { control: false },
  },
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

/** First use: invite the first step. */
export const Default: Story = {};

/** A search or filter matched nothing: offer to clear it. */
export const NoResults: Story = {
  args: {
    icon: <SearchMd />,
    title: "Nothing matches “banner”",
    description: "Try another word or clear the filters.",
    buttonProps: { children: "Clear filters", variant: "ghost" },
  },
};

export const Error: Story = {
  args: {
    tone: "error",
    icon: <AlertCircle />,
    title: "Couldn't load deployments",
    description: "The hosting provider didn't answer.",
    buttonProps: { children: "Try again" },
  },
};

/** Inside a card: a list or chart with no data. */
export const Inline: Story = {
  render: () => (
    <Card className="w-96">
      <CardHeader>
        <CardTitle>Recent runs</CardTitle>
      </CardHeader>
      <EmptyState
        size="inline"
        icon={<Zap />}
        title="No runs in this range"
        description="Pick a wider range to see older runs."
      />
    </Card>
  ),
};

/** The rare first-run moment: the agent offers to do it. */
export const WithAgent: Story = {
  args: {
    illustration: <AgentAvatar src={AGENT_FACE} size={48} />,
    title: "Nothing on the board yet",
    description: "Tell the agent a goal and it will plan the first tasks.",
    buttonComponent: <Button variant="agent">Ask the agent</Button>,
  },
};
