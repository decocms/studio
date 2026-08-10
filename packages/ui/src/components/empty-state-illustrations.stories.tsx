import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  AdminsIllustration,
  AgentsIllustration,
  ConnectionsIllustration,
  ExperimentsIllustration,
  GenericIllustration,
  PagesIllustration,
  StoreIllustration,
  TasksIllustration,
  WorkflowsIllustration,
} from "./empty-state-illustrations.tsx";

const meta = {
  title: "Components/EmptyStateIllustrations",
  parameters: { layout: "padded" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const illustrations = [
  { name: "Agents", Illustration: AgentsIllustration },
  { name: "Connections", Illustration: ConnectionsIllustration },
  { name: "Tasks", Illustration: TasksIllustration },
  { name: "Pages", Illustration: PagesIllustration },
  { name: "Experiments", Illustration: ExperimentsIllustration },
  { name: "Workflows", Illustration: WorkflowsIllustration },
  { name: "Admins", Illustration: AdminsIllustration },
  { name: "Store", Illustration: StoreIllustration },
  { name: "Generic", Illustration: GenericIllustration },
];

export const Gallery: Story = {
  render: () => (
    <div className="grid grid-cols-3 gap-4 max-w-2xl">
      {illustrations.map(({ name, Illustration }) => (
        <div
          key={name}
          className="flex flex-col items-center gap-1 rounded-lg border border-border p-4 text-muted-foreground"
        >
          <Illustration />
          <span className="text-xs font-medium text-foreground">{name}</span>
        </div>
      ))}
    </div>
  ),
};
