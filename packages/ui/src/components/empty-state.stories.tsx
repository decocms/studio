import type { Meta, StoryObj } from "@storybook/react-vite";
import { AlertTriangle, Bell01, Plus, SearchMd } from "@untitledui/icons";
import { Button } from "./button.tsx";
import { EmptyState } from "./empty-state.tsx";
import { ConnectionsIllustration } from "./empty-state-illustrations.tsx";

const meta = {
  title: "Components/EmptyState",
  component: EmptyState,
  args: {
    title: "No connections yet",
    description: "Connect your first MCP server to start routing traffic.",
  },
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithIcon: Story = {
  args: {
    icon: <SearchMd />,
    title: "No results found",
    description: "Try adjusting your search or filters.",
  },
};

export const WithIllustration: Story = {
  args: {
    illustration: <ConnectionsIllustration />,
  },
};

export const WithAction: Story = {
  args: {
    icon: <Plus />,
    buttonProps: {
      children: (
        <>
          <Plus /> New connection
        </>
      ),
      onClick: () => {},
    },
  },
};

export const WithTwoActions: Story = {
  args: {
    icon: <SearchMd />,
    title: "Site not found",
    description: "This site isn't linked to any project you can open.",
    buttonComponent: (
      <>
        <Button variant="outline" size="sm">
          Retry
        </Button>
        <Button size="sm">Back to Studio</Button>
      </>
    ),
  },
};

export const Destructive: Story = {
  args: {
    tone: "destructive",
    icon: <AlertTriangle />,
    title: "Couldn't start",
    description: "The sandbox failed to boot. Retry to start it again.",
    buttonProps: { variant: "outline", children: "Retry" },
  },
};

export const Small: Story = {
  args: {
    size: "sm",
    icon: <Bell01 />,
    title: "You're all caught up",
    description: "Updates on your tasks show up here.",
  },
};
