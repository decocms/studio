import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Matrix } from "../foundations/kit.tsx";
import { Stage, StageTracker } from "./stage-tracker.tsx";

const STAGES = ["Plan", "Execute", "Monitor"];
const WIZARD = ["Connect", "Configure", "Review"];

const meta = {
  title: "Molecules/StageTracker",
  component: StageTracker,
  args: { stages: STAGES, current: 1 },
  argTypes: {
    current: { control: { type: "range", min: 0, max: 3 } },
    variant: { control: "inline-radio", options: ["pill", "numbered"] },
  },
} satisfies Meta<typeof StageTracker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const States: Story = {
  parameters: { controls: { disable: true }, layout: "padded" },
  render: () => (
    <div className="flex flex-col gap-8">
      <Matrix
        columns={["Done", "Current", "Upcoming"]}
        rows={[
          {
            label: "Stage",
            cells: [
              <Stage key="done" state="done">
                Plan
              </Stage>,
              <Stage key="current" state="current">
                Plan
              </Stage>,
              <Stage key="upcoming" state="upcoming">
                Plan
              </Stage>,
            ],
          },
        ]}
      />
      <Matrix
        columns={["pill", "numbered"]}
        rows={["Plan", "Execute", "Monitor", "Done"].map((label, current) => ({
          label,
          cells: [
            <StageTracker key={label} stages={STAGES} current={current} />,
            <StageTracker
              key={`${label}-numbered`}
              variant="numbered"
              stages={WIZARD}
              current={current}
            />,
          ],
        }))}
      />
    </div>
  ),
};

/** A wizard: go back to any stage you already passed. */
export const Wizard: Story = {
  parameters: { controls: { disable: true } },
  render: () => <WizardDemo />,
};

function WizardDemo() {
  const [current, setCurrent] = useState(2);
  return (
    <StageTracker
      variant="numbered"
      stages={WIZARD}
      current={current}
      onStageClick={setCurrent}
      visited={new Set([0, 1, 2])}
    />
  );
}
