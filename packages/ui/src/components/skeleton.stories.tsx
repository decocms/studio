import type { Meta, StoryObj } from "@storybook/react-vite";
import { Skeleton } from "./skeleton.tsx";

const meta = {
  title: "Components/Skeleton",
  component: Skeleton,
} satisfies Meta<typeof Skeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <Skeleton className="h-4 w-64" />,
};

export const CardPlaceholder: Story = {
  render: () => (
    <div className="flex w-80 flex-col gap-3 rounded-lg border border-border p-4">
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  ),
};

export const ListPlaceholder: Story = {
  render: () => (
    <div className="flex w-80 flex-col gap-4">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
      ))}
    </div>
  ),
};
