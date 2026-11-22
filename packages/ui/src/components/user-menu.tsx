import {
  ResponsiveDropdown,
  ResponsiveDropdownContent,
  ResponsiveDropdownItem,
  ResponsiveDropdownSeparator,
  ResponsiveDropdownTrigger,
} from "./responsive-dropdown.tsx";
import type { ReactNode } from "react";

interface UserData {
  avatar?: string;
  name?: string;
  email?: string;
}

interface UserMenuProps {
  user: UserData;
  trigger: (user: UserData) => ReactNode;
  align?: "start" | "end";
  children: ReactNode;
}

interface UserMenuItemProps {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
  asChild?: boolean;
}

interface UserMenuSeparatorProps {
  className?: string;
}

function UserMenuRoot({
  user,
  trigger,
  align = "start",
  children,
}: UserMenuProps) {
  return (
    <ResponsiveDropdown>
      <ResponsiveDropdownTrigger asChild>
        <div>{trigger(user)}</div>
      </ResponsiveDropdownTrigger>
      <ResponsiveDropdownContent
        side="top"
        align={align}
        className="md:w-[240px]"
      >
        {children}
      </ResponsiveDropdownContent>
    </ResponsiveDropdown>
  );
}

function UserMenuItem({
  children,
  onClick,
  className,
  asChild,
}: UserMenuItemProps) {
  return (
    <ResponsiveDropdownItem asChild={asChild} className={className}>
      {asChild ? (
        children
      ) : (
        <button
          type="button"
          className="flex w-full cursor-pointer items-center gap-(--space-xs) text-s"
          onClick={onClick}
        >
          {children}
        </button>
      )}
    </ResponsiveDropdownItem>
  );
}

function UserMenuSeparator({ className }: UserMenuSeparatorProps) {
  return <ResponsiveDropdownSeparator className={className} />;
}

function UserMenuSkeleton() {
  return <div className="w-8 h-8 bg-muted rounded-full animate-pulse" />;
}

export const UserMenu = Object.assign(UserMenuRoot, {
  Item: UserMenuItem,
  Separator: UserMenuSeparator,
  Skeleton: UserMenuSkeleton,
});
