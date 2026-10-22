import type { Meta, StoryObj } from "@storybook/react-vite";
import { Copy01, SearchMd } from "@untitledui/icons";
import { IconButton } from "./icon-button.tsx";
import {
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "./input.tsx";
import { Label } from "./label.tsx";
import { Matrix } from "../foundations/kit.tsx";

const meta = {
  title: "Atoms/Input",
  component: Input,
  args: {
    placeholder: "Search connections...",
  },
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithLabel: Story = {
  render: () => (
    <div className="grid w-80 gap-2">
      <Label htmlFor="project-name">Project name</Label>
      <Input id="project-name" placeholder="my-storefront" />
    </div>
  ),
};

export const Types: Story = {
  render: () => (
    <div className="grid w-80 gap-4">
      <div className="grid gap-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" placeholder="ana@example.com" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="url">Webhook URL</Label>
        <Input id="url" type="url" placeholder="https://example.com/hooks" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="seats">Seats</Label>
        <Input id="seats" type="number" defaultValue={5} min={1} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="avatar">Avatar</Label>
        <Input id="avatar" type="file" />
      </div>
    </div>
  ),
};

export const Invalid: Story = {
  render: () => (
    <div className="grid w-80 gap-2">
      <Label htmlFor="slug">Organization slug</Label>
      <Input id="slug" defaultValue="Acme Inc!" aria-invalid />
      <p className="text-sm text-destructive">
        Slugs can only contain lowercase letters, numbers, and dashes.
      </p>
    </div>
  ),
};

export const Disabled: Story = {
  args: { disabled: true, value: "conn_9f2e1c" },
};

export const Variants: Story = {
  render: () => (
    <div className="grid w-80 gap-3">
      <Input placeholder="Project name" />
      <Input size="sm" placeholder="Project name" />
      <Input defaultValue="casa-aurora" data-valid />
      <Input defaultValue="Casa Aurora!" aria-invalid />
      <Input defaultValue="Read only" readOnly />
    </div>
  ),
};

export const States: Story = {
  parameters: {
    controls: { disable: true },
    layout: "padded",
    pseudo: {
      hover: [".is-hover"],
      focusVisible: [".is-focus"],
      active: [".is-active"],
    },
  },
  render: () => (
    <Matrix
      columns={[
        "Empty",
        "Filled",
        "Hover",
        "Focus",
        "Invalid",
        "Valid",
        "Read only",
        "Disabled",
      ]}
      rows={(["default", "sm"] as const).map((size) => ({
        label: size === "sm" ? "32" : "36",
        cells: [
          <Input
            key="empty"
            size={size}
            placeholder="Project name"
            className="w-44"
          />,
          <Input
            key="filled"
            size={size}
            defaultValue="Casa Aurora"
            className="w-44"
          />,
          <Input
            key="hover"
            size={size}
            defaultValue="Casa Aurora"
            className="is-hover w-44"
          />,
          <Input
            key="focus"
            size={size}
            defaultValue="Casa Aurora"
            className="is-focus w-44"
          />,
          <Input
            key="invalid"
            size={size}
            defaultValue="Casa Aurora!"
            aria-invalid
            className="w-44"
          />,
          <Input
            key="valid"
            size={size}
            defaultValue="casa-aurora"
            data-valid
            className="w-44"
          />,
          <Input
            key="readonly"
            size={size}
            defaultValue="casa-aurora"
            readOnly
            className="w-44"
          />,
          <Input
            key="disabled"
            size={size}
            defaultValue="Casa Aurora"
            disabled
            className="w-44"
          />,
        ],
      }))}
    />
  ),
};

/** Icons, text and buttons inside the field. Buttons sit 4px from every edge. */
export const Group: Story = {
  render: () => (
    <div className="grid w-80 gap-4">
      <InputGroup>
        <InputGroupAddon>
          <SearchMd />
        </InputGroupAddon>
        <InputGroupInput placeholder="Search connections" />
      </InputGroup>
      <InputGroup>
        <InputGroupAddon>https://</InputGroupAddon>
        <InputGroupInput className="pl-0" defaultValue="storefront.com" />
      </InputGroup>
      <InputGroup>
        <InputGroupInput readOnly defaultValue="sk_live_51Hx…9f2c" />
        <IconButton type="button" label="Copy">
          <Copy01 />
        </IconButton>
      </InputGroup>
      <InputGroup>
        <InputGroupInput aria-invalid defaultValue="not a url" />
      </InputGroup>
    </div>
  ),
};
