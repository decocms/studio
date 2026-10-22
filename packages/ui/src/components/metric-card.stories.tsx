import type { Meta, StoryObj } from "@storybook/react-vite";
import * as Recharts from "recharts";
import { Matrix } from "../foundations/kit.tsx";
import { type ChartConfig, ChartContainer } from "./chart.tsx";
import { MetricCard } from "./metric-card.tsx";
import { Sparkline } from "./sparkline.tsx";
import { ToggleGroup, ToggleGroupItem } from "./toggle-group.tsx";

const SERIES = [10, 11, 10, 12, 12, 12, 12, 13, 14, 14];

const LATENCY = [
  { day: "Mon", ms: 380 },
  { day: "Tue", ms: 420 },
  { day: "Wed", ms: 395 },
  { day: "Thu", ms: 460 },
  { day: "Fri", ms: 430 },
  { day: "Sat", ms: 390 },
  { day: "Sun", ms: 412 },
];

const CHART = {
  ms: { label: "Latency", color: "var(--chart-1)" },
} satisfies ChartConfig;

const meta = {
  title: "Molecules/Cards/MetricCard",
  component: MetricCard,
  args: {
    label: "Mobile conversion",
    value: "1.84%",
    caption: "Goal: 2.1%",
    status: "success",
    trend: <Sparkline values={SERIES} />,
  },
  argTypes: {
    status: {
      control: "inline-radio",
      options: [undefined, "success", "warning", "error"],
    },
    trend: { control: false },
  },
} satisfies Meta<typeof MetricCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: (args) => (
    <div className="w-64">
      <MetricCard {...args} />
    </div>
  ),
};

export const States: Story = {
  parameters: { controls: { disable: true }, layout: "padded" },
  render: () => (
    <Matrix
      columns={["On track", "Behind", "Off track", "No status"]}
      rows={[
        {
          label: "Metric",
          cells: (["success", "warning", "error", undefined] as const).map(
            (status) => (
              <div key={status ?? "none"} className="w-64">
                <MetricCard
                  label="Mobile conversion"
                  value="1.84%"
                  caption="Goal: 2.1%"
                  status={status}
                  trend={<Sparkline values={SERIES} />}
                />
              </div>
            ),
          ),
        },
      ]}
    />
  ),
};

/** The Monitor: a picker top right and a chart below the figure. */
export const WithChart: Story = {
  parameters: { controls: { disable: true }, layout: "padded" },
  render: () => (
    <MetricCard
      className="w-[28rem]"
      label="Latency"
      value="412 ms"
      caption="p95 · last 7 days"
      action={
        <ToggleGroup type="single" variant="segmented" defaultValue="p95">
          <ToggleGroupItem value="avg">Avg</ToggleGroupItem>
          <ToggleGroupItem value="p95">p95</ToggleGroupItem>
        </ToggleGroup>
      }
    >
      <ChartContainer config={CHART} className="h-36 w-full">
        <Recharts.AreaChart data={LATENCY} margin={{ left: 0, right: 0 }}>
          <Recharts.XAxis
            dataKey="day"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
          />
          <Recharts.Area
            dataKey="ms"
            type="monotone"
            stroke="var(--color-ms)"
            fill="var(--color-ms)"
            fillOpacity={0.15}
          />
        </Recharts.AreaChart>
      </ChartContainer>
    </MetricCard>
  ),
};

/** Opens the detail behind the number. */
export const Clickable: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <MetricCard
      className="w-64"
      interactive
      onClick={() => {}}
      label="Tasks done"
      value="42"
      caption="8 more than last week"
      status="success"
    />
  ),
};
