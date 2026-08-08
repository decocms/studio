import type { Meta, StoryObj } from "@storybook/react-vite";
import { DotsHorizontal } from "@untitledui/icons";
import { Avatar } from "./avatar.tsx";
import { Button } from "./button.tsx";
import { EntityCard } from "./entity-card.tsx";

const meta = {
  title: "Components/EntityCard",
  component: EntityCard,
  // All stories use render(); children is only here to satisfy the required prop.
  args: { children: null },
} satisfies Meta<typeof EntityCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="w-72">
      <EntityCard>
        <EntityCard.Header>
          <EntityCard.AvatarSection>
            <EntityCard.Avatar fallback="Slack" />
            <Button variant="ghost" size="icon" aria-label="Options">
              <DotsHorizontal />
            </Button>
          </EntityCard.AvatarSection>
          <EntityCard.Content>
            <EntityCard.Title>Slack</EntityCard.Title>
            <EntityCard.Subtitle>
              Send messages and manage channels
            </EntityCard.Subtitle>
          </EntityCard.Content>
        </EntityCard.Header>
        <EntityCard.Footer>
          <EntityCard.Badge>12 tools</EntityCard.Badge>
          <div className="flex items-center">
            <Avatar fallback="Maya Chen" shape="circle" size="2xs" />
            <Avatar
              fallback="Leo Park"
              shape="circle"
              size="2xs"
              className="-ml-1"
            />
          </div>
        </EntityCard.Footer>
      </EntityCard>
    </div>
  ),
};

export const Clickable: Story = {
  render: () => (
    <div className="w-72">
      <EntityCard onNavigate={() => {}} showHoverRing>
        <EntityCard.Header>
          <EntityCard.AvatarSection>
            <EntityCard.Avatar fallback="GitHub" />
          </EntityCard.AvatarSection>
          <EntityCard.Content>
            <EntityCard.Title>GitHub</EntityCard.Title>
            <EntityCard.Subtitle>
              Manage repositories, issues and pull requests
            </EntityCard.Subtitle>
          </EntityCard.Content>
        </EntityCard.Header>
        <EntityCard.Footer>
          <EntityCard.Badge>28 tools</EntityCard.Badge>
        </EntityCard.Footer>
      </EntityCard>
    </div>
  ),
};

export const Loading: Story = {
  render: () => (
    <div className="w-72">
      <EntityCard.Skeleton />
    </div>
  ),
};
