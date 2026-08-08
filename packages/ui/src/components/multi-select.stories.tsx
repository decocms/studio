import type { Meta, StoryObj } from "@storybook/react-vite";
import { Cube01, Globe01, Lock01, Users01 } from "@untitledui/icons";
import { MultiSelect, type Option } from "./multi-select.tsx";

const projectOptions: Option[] = [
  { label: "Storefront", value: "storefront" },
  { label: "Checkout", value: "checkout" },
  { label: "Internal tools", value: "internal-tools" },
  { label: "Marketing site", value: "marketing-site" },
  { label: "Mobile app", value: "mobile-app" },
  { label: "Data pipeline", value: "data-pipeline" },
];

const roleOptions: Option[] = [
  { label: "Admins", value: "admins", icon: Lock01 },
  { label: "Members", value: "members", icon: Users01 },
  { label: "Guests", value: "guests", icon: Globe01 },
  { label: "Service accounts", value: "service-accounts", icon: Cube01 },
];

const meta = {
  title: "Components/MultiSelect",
  component: MultiSelect,
  args: {
    options: projectOptions,
    onValueChange: () => {},
    placeholder: "Select projects",
  },
} satisfies Meta<typeof MultiSelect>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithSelection: Story = {
  args: {
    defaultValue: ["storefront", "checkout"],
  },
};

/** More selections than `maxCount` collapse into a "+n" badge. */
export const OverflowBadge: Story = {
  args: {
    defaultValue: ["storefront", "checkout", "internal-tools", "mobile-app"],
    maxCount: 2,
  },
};

export const WithIcons: Story = {
  args: {
    options: roleOptions,
    defaultValue: ["admins", "members"],
    placeholder: "Select roles",
  },
};

export const Disabled: Story = {
  args: {
    defaultValue: ["storefront"],
    disabled: true,
  },
};
