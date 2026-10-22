import type { Meta, StoryObj } from "@storybook/react-vite";
import { BookOpen01, Globe02, LayoutAlt01, Phone01 } from "@untitledui/icons";
import { Matrix } from "../foundations/kit.tsx";
import { ProjectIcon } from "./project-icon.tsx";

const PROJECTS = [
  { name: "Site", color: "blue", icon: <Globe02 /> },
  { name: "Sales app", color: "green", icon: <Phone01 /> },
  { name: "Blog", color: "purple", icon: <BookOpen01 /> },
  { name: "Landing pages", color: "red", icon: <LayoutAlt01 /> },
] as const;

const meta = {
  title: "Atoms/ProjectIcon",
  component: ProjectIcon,
  args: { color: "blue", size: "default", children: <Globe02 /> },
  argTypes: {
    color: {
      control: "inline-radio",
      options: ["blue", "green", "purple", "red", "amber"],
    },
    size: { control: "inline-radio", options: ["sm", "default"] },
    children: { control: false },
  },
} satisfies Meta<typeof ProjectIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Projects: Story = {
  parameters: { controls: { disable: true }, layout: "padded" },
  render: () => (
    <Matrix
      columns={["20 · nav, chips", "28 · rails, cards"]}
      rows={PROJECTS.map((project) => ({
        label: project.name,
        cells: [
          <ProjectIcon key="sm" color={project.color} size="sm">
            {project.icon}
          </ProjectIcon>,
          <ProjectIcon key="md" color={project.color}>
            {project.icon}
          </ProjectIcon>,
        ],
      }))}
    />
  ),
};
