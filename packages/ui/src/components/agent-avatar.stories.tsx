import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentAvatar } from "./agent-avatar.tsx";

const AGENT_FACE =
  "https://assets.decocache.com/decocms/fd07a578-6b1c-40f1-bc05-88a3b981695d/f7fc4ffa81aec04e37ae670c3cd4936643a7b269.png";

const meta = {
  title: "Atoms/AgentAvatar",
  component: AgentAvatar,
  args: { src: AGENT_FACE, size: 26, alt: "deco agent" },
} satisfies Meta<typeof AgentAvatar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Sizes: Story = {
  render: (args) => (
    <div className="flex items-center gap-3">
      {[16, 20, 24, 26, 32].map((size) => (
        <AgentAvatar key={size} {...args} size={size} />
      ))}
    </div>
  ),
};
