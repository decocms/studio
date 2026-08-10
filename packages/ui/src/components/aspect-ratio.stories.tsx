import type { Meta, StoryObj } from "@storybook/react-vite";
import { Image01 } from "@untitledui/icons";
import { AspectRatio } from "./aspect-ratio.tsx";

const meta = {
  title: "Components/AspectRatio",
  component: AspectRatio,
  args: {
    ratio: 16 / 9,
  },
} satisfies Meta<typeof AspectRatio>;

export default meta;
type Story = StoryObj<typeof meta>;

function Placeholder({ label }: { label: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 rounded-md bg-muted text-muted-foreground">
      <Image01 className="size-6" />
      <span className="text-sm">{label}</span>
    </div>
  );
}

export const Default: Story = {
  render: () => (
    <div className="w-96">
      <AspectRatio ratio={16 / 9}>
        <Placeholder label="Project cover (16:9)" />
      </AspectRatio>
    </div>
  ),
};

export const Square: Story = {
  render: () => (
    <div className="w-48">
      <AspectRatio ratio={1}>
        <Placeholder label="Logo (1:1)" />
      </AspectRatio>
    </div>
  ),
};

export const Portrait: Story = {
  render: () => (
    <div className="w-48">
      <AspectRatio ratio={3 / 4}>
        <Placeholder label="Poster (3:4)" />
      </AspectRatio>
    </div>
  ),
};
