import type { Meta, StoryObj } from "@storybook/react-vite";
import { Plus, SearchMd } from "@untitledui/icons";
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
    icon: <SearchMd className="size-5" />,
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
    illustration: <ConnectionsIllustration />,
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
