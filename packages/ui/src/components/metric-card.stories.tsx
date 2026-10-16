import type { Meta, StoryObj } from "@storybook/react-vite";
import { Stars01 } from "@untitledui/icons";
import { Button } from "./button.tsx";
import { ListRow } from "./list-row.tsx";
import { MetricCard } from "./metric-card.tsx";
import { Sparkline } from "./sparkline.tsx";

const SERIES = [10, 11, 10, 12, 12, 12, 12, 13, 14, 14];

const meta = {
  title: "Components/Metric card",
  component: MetricCard,
  args: {
    label: "Mobile conversion",
    value: "1.84%",
    caption: "Grow mobile sales to R$ 48M",
    status: "success",
    trend: <Sparkline values={SERIES} />,
  },
} satisfies Meta<typeof MetricCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <div className="grid w-[56rem] grid-cols-4 gap-4">
      <MetricCard {...args} />
      <MetricCard {...args} status="warning" />
      <MetricCard {...args} status="error" />
      <MetricCard {...args} status={undefined} />
    </div>
  ),
};

export const ListRows: Story = {
  render: () => (
    <div className="w-[25rem]">
      {(["default", "divided"] as const).map((variant) => (
        <ListRow
          key={variant}
          variant={variant}
          lead={<Stars01 />}
          title="Black Friday creative review"
          meta="Meeting · 14:00 · prep ready"
          trailing={
            <Button size="sm" variant="ghost">
              Prep
            </Button>
          }
        />
      ))}
    </div>
  ),
};
