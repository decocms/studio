import type { Meta, StoryObj } from "@storybook/react-vite";
import { Grid01, Plus } from "@untitledui/icons";
import { useState } from "react";
import {
  TopbarSwitcher,
  type TopbarSwitcherEntity,
} from "./topbar-switcher.tsx";

const meta = {
  title: "Components/TopbarSwitcher",
  component: TopbarSwitcher,
  // All stories use render(); children is only here to satisfy the required prop.
  args: { children: null },
} satisfies Meta<typeof TopbarSwitcher>;

export default meta;
type Story = StoryObj<typeof meta>;

const organizations: TopbarSwitcherEntity[] = [
  { slug: "acme", name: "Acme Inc" },
  { slug: "globex", name: "Globex Corporation" },
  { slug: "initech", name: "Initech" },
  { slug: "umbrella", name: "Umbrella Labs" },
];

const projectsByOrg: Record<string, TopbarSwitcherEntity[]> = {
  acme: [
    { slug: "storefront", name: "Storefront" },
    { slug: "checkout", name: "Checkout" },
    { slug: "internal-tools", name: "Internal tools" },
  ],
  globex: [{ slug: "landing", name: "Landing pages" }],
  initech: [
    { slug: "tps-reports", name: "TPS Reports" },
    { slug: "billing", name: "Billing" },
  ],
  umbrella: [],
};

function OrganizationSwitcherDemo() {
  const [current, setCurrent] = useState(organizations[0]);
  const [search, setSearch] = useState("");

  const filtered = organizations.filter((org) =>
    org.name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <TopbarSwitcher>
      <TopbarSwitcher.Trigger>
        <TopbarSwitcher.CurrentItem item={current} />
      </TopbarSwitcher.Trigger>
      <TopbarSwitcher.Content>
        <TopbarSwitcher.Panel>
          <TopbarSwitcher.Search
            placeholder="Search organizations..."
            value={search}
            onChange={setSearch}
          />
          <TopbarSwitcher.Items emptyMessage="No organizations found.">
            {filtered.map((org) => (
              <TopbarSwitcher.Item
                key={org.slug}
                item={org}
                onClick={setCurrent}
              />
            ))}
          </TopbarSwitcher.Items>
          <TopbarSwitcher.Separator />
          <TopbarSwitcher.Actions>
            <TopbarSwitcher.Action onClick={() => {}} icon={<Plus />}>
              Create organization
            </TopbarSwitcher.Action>
            <TopbarSwitcher.Action
              onClick={() => {}}
              icon={<Grid01 />}
              variant="muted"
            >
              See all organizations
            </TopbarSwitcher.Action>
          </TopbarSwitcher.Actions>
        </TopbarSwitcher.Panel>
      </TopbarSwitcher.Content>
    </TopbarSwitcher>
  );
}

function TwoPanelSwitcherDemo() {
  const [currentOrg, setCurrentOrg] = useState(organizations[0]);
  const [previewOrg, setPreviewOrg] = useState(organizations[0]);
  const [search, setSearch] = useState("");

  const filtered = organizations.filter((org) =>
    org.name.toLowerCase().includes(search.toLowerCase()),
  );
  const projects = previewOrg ? (projectsByOrg[previewOrg.slug] ?? []) : [];

  return (
    <TopbarSwitcher>
      <TopbarSwitcher.Trigger>
        <TopbarSwitcher.CurrentItem item={currentOrg} />
      </TopbarSwitcher.Trigger>
      <TopbarSwitcher.Content>
        <TopbarSwitcher.Panel>
          <TopbarSwitcher.Search
            placeholder="Search organizations..."
            value={search}
            onChange={setSearch}
          />
          <TopbarSwitcher.Items emptyMessage="No organizations found.">
            {filtered.map((org) => (
              <TopbarSwitcher.Item
                key={org.slug}
                item={org}
                onClick={setCurrentOrg}
                onHover={setPreviewOrg}
              />
            ))}
          </TopbarSwitcher.Items>
          <TopbarSwitcher.Separator />
          <TopbarSwitcher.Actions>
            <TopbarSwitcher.Action onClick={() => {}} icon={<Plus />}>
              Create organization
            </TopbarSwitcher.Action>
          </TopbarSwitcher.Actions>
        </TopbarSwitcher.Panel>
        <TopbarSwitcher.Panel>
          <TopbarSwitcher.Items emptyMessage="No projects in this organization.">
            {projects.map((project) => (
              <TopbarSwitcher.Item
                key={project.slug}
                item={project}
                onClick={() => {}}
              />
            ))}
          </TopbarSwitcher.Items>
          <TopbarSwitcher.Separator />
          <TopbarSwitcher.Actions>
            <TopbarSwitcher.Action onClick={() => {}} icon={<Plus />}>
              Create project
            </TopbarSwitcher.Action>
          </TopbarSwitcher.Actions>
        </TopbarSwitcher.Panel>
      </TopbarSwitcher.Content>
    </TopbarSwitcher>
  );
}

export const Default: Story = {
  render: () => <OrganizationSwitcherDemo />,
};

export const TwoPanels: Story = {
  render: () => <TwoPanelSwitcherDemo />,
};

export const Loading: Story = {
  render: () => <TopbarSwitcher.Skeleton />,
};
