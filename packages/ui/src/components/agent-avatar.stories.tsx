import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentAvatar } from "./agent-avatar.tsx";
import { OrgAvatar } from "./org-avatar.tsx";
import { ProjectIcon } from "./project-icon.tsx";
import { BookOpen01, Globe02, LayoutAlt01, Phone01 } from "@untitledui/icons";

const AGENT_FACE =
  "https://assets.decocache.com/decocms/fd07a578-6b1c-40f1-bc05-88a3b981695d/f7fc4ffa81aec04e37ae670c3cd4936643a7b269.png";

const meta = {
  title: "Components/Identity",
  component: AgentAvatar,
  args: { src: AGENT_FACE, size: 24 },
} satisfies Meta<typeof AgentAvatar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Agent: Story = {
  render: (args) => (
    <div className="flex items-center gap-3">
      {[16, 20, 24, 26, 32].map((size) => (
        <AgentAvatar key={size} {...args} size={size} />
      ))}
    </div>
  ),
};

export const Organizations: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <OrgAvatar name="Casa Aurora" size="sm" />
      <OrgAvatar name="Casa Aurora" />
      <OrgAvatar name="Casa Aurora" selected />
      <OrgAvatar name="deco" src={AGENT_FACE} selected />
    </div>
  ),
};

export const Projects: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      {(["sm", "default"] as const).map((size) => (
        <div key={size} className="flex items-center gap-3">
          <ProjectIcon color="blue" size={size}>
            <Globe02 />
          </ProjectIcon>
          <ProjectIcon color="green" size={size}>
            <Phone01 />
          </ProjectIcon>
          <ProjectIcon color="purple" size={size}>
            <BookOpen01 />
          </ProjectIcon>
          <ProjectIcon color="red" size={size}>
            <LayoutAlt01 />
          </ProjectIcon>
        </div>
      ))}
    </div>
  ),
};
