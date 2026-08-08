import type { Meta, StoryObj } from "@storybook/react-vite";
import { Avatar } from "./avatar.tsx";

const meta = {
  title: "Components/Avatar",
  component: Avatar,
  args: {
    fallback: "Ana Souza",
    shape: "square",
    size: "base",
    muted: false,
  },
  argTypes: {
    shape: {
      control: "select",
      options: ["circle", "square"],
    },
    size: {
      control: "select",
      options: ["3xs", "2xs", "xs", "sm", "base", "lg", "xl", "2xl", "3xl"],
    },
    objectFit: {
      control: "select",
      options: ["contain", "cover"],
    },
  },
} satisfies Meta<typeof Avatar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Shapes: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <Avatar shape="circle" fallback="Ana Souza" />
      <Avatar shape="square" fallback="Acme Inc" />
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className="flex items-end gap-3">
      <Avatar size="3xs" fallback="Ana Souza" />
      <Avatar size="2xs" fallback="Ana Souza" />
      <Avatar size="xs" fallback="Ana Souza" />
      <Avatar size="sm" fallback="Ana Souza" />
      <Avatar size="base" fallback="Ana Souza" />
      <Avatar size="lg" fallback="Ana Souza" />
      <Avatar size="xl" fallback="Ana Souza" />
      <Avatar size="2xl" fallback="Ana Souza" />
    </div>
  ),
};

export const FallbackColors: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <Avatar shape="circle" fallback="Ana Souza" />
      <Avatar shape="circle" fallback="Bruno Lima" />
      <Avatar shape="circle" fallback="Carla Mendes" />
      <Avatar shape="circle" fallback="Diego Santos" />
      <Avatar shape="circle" fallback="Elisa Rocha" />
    </div>
  ),
};

export const Muted: Story = {
  args: { muted: true, fallback: "Deleted user" },
};

export const Skeleton: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <Avatar.Skeleton shape="circle" size="base" />
      <Avatar.Skeleton shape="square" size="base" />
      <Avatar.Skeleton shape="square" size="lg" />
    </div>
  ),
};
