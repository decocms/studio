import type { Meta, StoryObj } from "@storybook/react-vite";
import { Sparkline } from "./sparkline.tsx";

const meta = {
  title: "Atoms/Sparkline",
  component: Sparkline,
  args: { values: [10, 11, 10, 12, 12, 12, 12, 13, 14, 14] },
} satisfies Meta<typeof Sparkline>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Falling: Story = {
  args: { values: [14, 14, 13, 12, 12, 11, 10, 9, 8, 6] },
};
