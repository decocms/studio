import type { Meta, StoryObj } from "@storybook/react-vite";
import { CreditCard01, LogOut01, Settings01, Users01 } from "@untitledui/icons";
import { Avatar } from "./avatar.tsx";
import { UserMenu } from "./user-menu.tsx";

const meta = {
  title: "Components/UserMenu",
  component: UserMenu,
  // All stories use render(); args only satisfy the required props.
  args: {
    user: { name: "Maya Chen", email: "maya@acme.com" },
    trigger: () => null,
    children: null,
  },
} satisfies Meta<typeof UserMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

const user = {
  name: "Maya Chen",
  email: "maya@acme.com",
};

export const Default: Story = {
  render: () => (
    <UserMenu
      user={user}
      trigger={(u) => (
        <button
          type="button"
          className="flex items-center gap-2 rounded-lg p-1.5 hover:bg-accent cursor-pointer"
        >
          <Avatar fallback={u.name ?? ""} shape="circle" size="xs" />
          <div className="flex flex-col items-start min-w-0">
            <span className="text-sm font-medium truncate">{u.name}</span>
            <span className="text-xs text-muted-foreground truncate">
              {u.email}
            </span>
          </div>
        </button>
      )}
    >
      <UserMenu.Item onClick={() => {}}>
        <Settings01 className="size-4" /> Account settings
      </UserMenu.Item>
      <UserMenu.Item onClick={() => {}}>
        <Users01 className="size-4" /> Invite members
      </UserMenu.Item>
      <UserMenu.Item onClick={() => {}}>
        <CreditCard01 className="size-4" /> Billing
      </UserMenu.Item>
      <UserMenu.Separator />
      <UserMenu.Item onClick={() => {}} className="text-destructive">
        <LogOut01 className="size-4" /> Sign out
      </UserMenu.Item>
    </UserMenu>
  ),
};

export const Loading: Story = {
  render: () => <UserMenu.Skeleton />,
};
