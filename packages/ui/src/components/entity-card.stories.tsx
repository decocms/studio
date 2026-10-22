import type { Meta, StoryObj } from "@storybook/react-vite";
import { DotsHorizontal, Globe02 } from "@untitledui/icons";
import { Matrix } from "../foundations/kit.tsx";
import { Avatar } from "./avatar.tsx";
import { Badge, BadgeDot } from "./badge.tsx";
import { EntityCard } from "./entity-card.tsx";
import { IconButton } from "./icon-button.tsx";
import { ProjectIcon } from "./project-icon.tsx";
import { TooltipProvider } from "./tooltip.tsx";

const meta = {
  title: "Molecules/Cards/EntityCard",
  component: EntityCard,
} satisfies Meta<typeof EntityCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A project: its icon, name, status and last update. */
export const Project: Story = {
  render: () => (
    <EntityCard onClick={() => {}} className="w-72">
      <EntityCard.Header
        icon={
          <ProjectIcon color="blue">
            <Globe02 />
          </ProjectIcon>
        }
        trailing={
          <Badge variant="success">
            <BadgeDot /> Live
          </Badge>
        }
      />
      <EntityCard.Title>Storefront</EntityCard.Title>
      <EntityCard.Description>Updated 3 hours ago</EntityCard.Description>
    </EntityCard>
  ),
};

/** A connection: its logo, what it does, and a footer with counts. */
export const Connection: Story = {
  render: () => (
    <TooltipProvider>
      <EntityCard onClick={() => {}} className="w-72">
        <EntityCard.Header
          icon={<Avatar fallback="Slack" size="sm" />}
          trailing={
            <IconButton label="Options">
              <DotsHorizontal />
            </IconButton>
          }
        />
        <EntityCard.Title>Slack</EntityCard.Title>
        <EntityCard.Description>
          Send messages and manage channels
        </EntityCard.Description>
        <EntityCard.Footer>
          <span>12 tools</span>
          <span>Used 2h ago</span>
        </EntityCard.Footer>
      </EntityCard>
    </TooltipProvider>
  ),
};

export const States: Story = {
  parameters: {
    layout: "padded",
    pseudo: { hover: [".is-hover"], focusVisible: [".is-focus"] },
  },
  render: () => (
    <Matrix
      columns={["Default", "Hover", "Focus", "Loading"]}
      rows={[
        {
          label: "Project",
          cells: [
            ...["", "is-hover", "is-focus"].map((state) => (
              <EntityCard
                key={state}
                onClick={() => {}}
                tabIndex={0}
                className={`w-56 ${state}`}
              >
                <EntityCard.Header
                  icon={
                    <ProjectIcon color="blue">
                      <Globe02 />
                    </ProjectIcon>
                  }
                />
                <EntityCard.Title>Storefront</EntityCard.Title>
                <EntityCard.Description>
                  Updated 3 hours ago
                </EntityCard.Description>
              </EntityCard>
            )),
            <div key="loading" className="w-56">
              <EntityCard.Skeleton />
            </div>,
          ],
        },
      ]}
    />
  ),
};
