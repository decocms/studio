import type { Meta, StoryObj } from "@storybook/react-vite";
import { Globe02, Target04 } from "@untitledui/icons";
import { Matrix } from "../foundations/kit.tsx";
import { Chip, ChipMeta } from "./chip.tsx";
import { ProjectIcon } from "./project-icon.tsx";

const meta = {
  title: "Atoms/Chip",
  component: Chip,
  args: { size: "sm", children: "Mobile conversion" },
  argTypes: {
    size: { control: "inline-radio", options: ["sm", "lg"] },
    children: { control: "text" },
  },
} satisfies Meta<typeof Chip>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Rendered as a button, so hover and focus show here too. */
export const Playground: Story = {
  render: (args) => (
    <Chip {...args} asChild>
      <button type="button">{args.children}</button>
    </Chip>
  ),
};

const goal = (
  <>
    <Target04 /> Mobile conversion
  </>
);
const app = (
  <>
    <ProjectIcon color="blue" className="size-[1.625rem] rounded-full">
      <Globe02 className="size-3.5" />
    </ProjectIcon>
    Site Editor <ChipMeta>Site</ChipMeta>
  </>
);

export const States: Story = {
  parameters: {
    controls: { disable: true },
    layout: "padded",
    pseudo: { hover: [".is-hover"], focusVisible: [".is-focus"] },
  },
  render: () => (
    <Matrix
      columns={["Default", "Hover", "Focus"]}
      proposed={["Hover", "Focus"]}
      rows={[
        { label: "sm · goal", content: goal, size: "sm" as const },
        { label: "lg · app", content: app, size: "lg" as const },
      ].map((row) => ({
        label: row.label,
        cells: ["", "is-hover", "is-focus"].map((state) => (
          <Chip key={state} size={row.size} asChild>
            <button type="button" className={state}>
              {row.content}
            </button>
          </Chip>
        )),
      }))}
    />
  ),
};
