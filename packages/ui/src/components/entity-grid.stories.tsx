import type { Meta, StoryObj } from "@storybook/react-vite";
import { Avatar } from "./avatar.tsx";
import { EntityCard } from "./entity-card.tsx";
import { EntityGrid } from "./entity-grid.tsx";

const meta = {
  title: "Organisms/EntityGrid",
  component: EntityGrid,
  parameters: { layout: "padded" },
  // All stories use render(); children is only here to satisfy the required prop.
  args: { children: null },
} satisfies Meta<typeof EntityGrid>;

export default meta;
type Story = StoryObj<typeof meta>;

const connections = [
  {
    name: "Slack",
    description: "Send messages and manage channels",
    tools: 12,
  },
  {
    name: "GitHub",
    description: "Repositories, issues and pull requests",
    tools: 28,
  },
  { name: "Linear", description: "Create and triage issues", tools: 9 },
  {
    name: "Notion",
    description: "Read and write pages and databases",
    tools: 15,
  },
  {
    name: "Stripe",
    description: "Payments, customers and invoices",
    tools: 21,
  },
  { name: "Postgres", description: "Query your production database", tools: 6 },
  { name: "Google Drive", description: "Search and fetch documents", tools: 8 },
  { name: "Figma", description: "Inspect files and export assets", tools: 5 },
];

function ConnectionCard({
  name,
  description,
  tools,
}: (typeof connections)[number]) {
  return (
    <EntityCard onClick={() => {}}>
      <EntityCard.Header icon={<Avatar fallback={name} size="sm" />} />
      <EntityCard.Title>{name}</EntityCard.Title>
      <EntityCard.Description>{description}</EntityCard.Description>
      <EntityCard.Footer>{tools} tools</EntityCard.Footer>
    </EntityCard>
  );
}

export const Default: Story = {
  render: () => (
    <div className="@container w-full">
      <EntityGrid>
        {connections.map((connection) => (
          <ConnectionCard key={connection.name} {...connection} />
        ))}
      </EntityGrid>
    </div>
  ),
};

export const TwoColumns: Story = {
  render: () => (
    <div className="@container w-full max-w-2xl">
      <EntityGrid columns={{ sm: 1, md: 2 }} gap={6}>
        {connections.slice(0, 4).map((connection) => (
          <ConnectionCard key={connection.name} {...connection} />
        ))}
      </EntityGrid>
    </div>
  ),
};

export const Loading: Story = {
  render: () => (
    <div className="@container w-full">
      <EntityGrid.Skeleton count={8} />
    </div>
  ),
};
