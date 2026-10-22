import type { Meta, StoryObj } from "@storybook/react-vite";
import { Matrix } from "../foundations/kit.tsx";
import { Avatar } from "./avatar.tsx";

const meta = {
  title: "Atoms/Avatar",
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
      <Avatar size="md" fallback="Ana Souza" />{" "}
      <Avatar size="md" tone="solid" fallback="Casa Aurora" />
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
      <Avatar shape="circle" fallback="Carla Mendes" />
      <Avatar shape="circle" fallback="Joana Pires" />
      <Avatar shape="circle" fallback="Bruno Lima" />
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

const LOGO =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'><rect width='40' height='40' fill='white'/><circle cx='20' cy='20' r='9' fill='%2307401a'/></svg>";

export const WithImage: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <Avatar url={LOGO} fallback="Acme" />
      <Avatar url="icon://user" fallback="Guest" shape="circle" />
    </div>
  ),
};

/** An org in the rail: its logo, or a grey initial; the current one is ringed. */
export const Organization: Story = {
  parameters: { controls: { disable: true }, layout: "padded" },
  render: () => (
    <Matrix
      columns={["Logo", "No logo", "Selected"]}
      rows={(["xs", "sm"] as const).map((size) => ({
        label: size === "xs" ? "24" : "32",
        cells: [
          <Avatar key="logo" size={size} url={LOGO} fallback="Casa Aurora" />,
          <Avatar key="initial" size={size} fallback="Casa Aurora" muted />,
          <Avatar
            key="selected"
            size={size}
            url={LOGO}
            fallback="Casa Aurora"
            selected
          />,
        ],
      }))}
    />
  ),
};
