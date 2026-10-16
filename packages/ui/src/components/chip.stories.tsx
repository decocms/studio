import type { Meta, StoryObj } from "@storybook/react-vite";
import { Globe02, Target04 } from "@untitledui/icons";
import { Chip, ChipMeta } from "./chip.tsx";
import { ProjectIcon } from "./project-icon.tsx";
import { Stage, StageTracker } from "./stage-tracker.tsx";

const meta = {
  title: "Components/Chip",
  component: Chip,
  args: { children: "Mobile conversion" },
} satisfies Meta<typeof Chip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <Chip>
        <Target04 /> Mobile conversion
      </Chip>
      <Chip size="lg">
        <ProjectIcon color="blue" className="size-[1.625rem] rounded-full">
          <Globe02 className="size-3.5" />
        </ProjectIcon>
        Site Editor <ChipMeta>Site</ChipMeta>
      </Chip>
    </div>
  ),
};

export const Stages: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Stage state="done">Plan</Stage>
        <Stage state="current">Plan</Stage>
        <Stage state="upcoming">Plan</Stage>
      </div>
      {[0, 1, 2, 3].map((current) => (
        <StageTracker
          key={current}
          stages={["Plan", "Execute", "Monitor"]}
          current={current}
        />
      ))}
    </div>
  ),
};
