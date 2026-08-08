import type { Meta, StoryObj } from "@storybook/react-vite";
import * as Recharts from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "./chart.tsx";

const toolCallsData = [
  { day: "Mon", desktop: 1860, mobile: 800 },
  { day: "Tue", desktop: 3050, mobile: 1200 },
  { day: "Wed", desktop: 2370, mobile: 1180 },
  { day: "Thu", desktop: 2890, mobile: 1390 },
  { day: "Fri", desktop: 3490, mobile: 1520 },
  { day: "Sat", desktop: 1140, mobile: 980 },
  { day: "Sun", desktop: 920, mobile: 860 },
];

const toolCallsConfig = {
  desktop: { label: "Desktop", color: "var(--chart-1)" },
  mobile: { label: "Mobile", color: "var(--chart-2)" },
} satisfies ChartConfig;

const meta = {
  title: "Components/Chart",
  component: ChartContainer,
  parameters: { layout: "padded" },
  args: {
    config: toolCallsConfig,
    className: "min-h-[240px] w-full max-w-xl",
    children: (
      <Recharts.BarChart data={toolCallsData}>
        <Recharts.CartesianGrid vertical={false} />
        <Recharts.XAxis
          dataKey="day"
          tickLine={false}
          tickMargin={8}
          axisLine={false}
        />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Recharts.Bar
          dataKey="desktop"
          fill="var(--color-desktop)"
          radius={4}
        />
        <Recharts.Bar dataKey="mobile" fill="var(--color-mobile)" radius={4} />
      </Recharts.BarChart>
    ),
  },
} satisfies Meta<typeof ChartContainer>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Tool calls per day, split by client platform. */
export const Bar: Story = {};

const activeOrgsData = [
  { month: "Jan", orgs: 84 },
  { month: "Feb", orgs: 112 },
  { month: "Mar", orgs: 141 },
  { month: "Apr", orgs: 138 },
  { month: "May", orgs: 187 },
  { month: "Jun", orgs: 236 },
];

const activeOrgsConfig = {
  orgs: { label: "Active organizations", color: "var(--chart-2)" },
} satisfies ChartConfig;

export const Line: Story = {
  render: () => (
    <ChartContainer
      config={activeOrgsConfig}
      className="min-h-[240px] w-full max-w-xl"
    >
      <Recharts.LineChart data={activeOrgsData}>
        <Recharts.CartesianGrid vertical={false} />
        <Recharts.XAxis
          dataKey="month"
          tickLine={false}
          tickMargin={8}
          axisLine={false}
        />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Recharts.Line
          dataKey="orgs"
          type="monotone"
          stroke="var(--color-orgs)"
          strokeWidth={2}
          dot={false}
        />
      </Recharts.LineChart>
    </ChartContainer>
  ),
};

const connectionTypesData = [
  { type: "http", connections: 412, fill: "var(--color-http)" },
  { type: "sse", connections: 187, fill: "var(--color-sse)" },
  { type: "stdio", connections: 96, fill: "var(--color-stdio)" },
  { type: "websocket", connections: 41, fill: "var(--color-websocket)" },
];

const connectionTypesConfig = {
  connections: { label: "Connections" },
  http: { label: "Streamable HTTP", color: "var(--chart-1)" },
  sse: { label: "SSE", color: "var(--chart-2)" },
  stdio: { label: "stdio", color: "var(--chart-4)" },
  websocket: { label: "WebSocket", color: "var(--chart-5)" },
} satisfies ChartConfig;

export const Pie: Story = {
  render: () => (
    <ChartContainer
      config={connectionTypesConfig}
      className="mx-auto aspect-square max-h-[280px]"
    >
      <Recharts.PieChart>
        <ChartTooltip
          content={<ChartTooltipContent nameKey="type" hideLabel />}
        />
        <Recharts.Pie
          data={connectionTypesData}
          dataKey="connections"
          nameKey="type"
          innerRadius={60}
        />
        <ChartLegend content={<ChartLegendContent nameKey="type" />} />
      </Recharts.PieChart>
    </ChartContainer>
  ),
};
