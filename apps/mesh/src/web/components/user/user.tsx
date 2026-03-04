/**
 * User Display Component
 *
 * Displays user information (avatar + name/email) by fetching user data from the API.
 * Handles loading and error states gracefully.
 */

import { Avatar, type AvatarProps } from "@deco/ui/components/avatar.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { useUserById } from "../../hooks/use-user-by-id";

export interface UserProps {
  /**
   * User ID to display
   */
  id: string;
  /**
   * Avatar size (default: "xs")
   */
  size?: AvatarProps["size"];
  /**
   * Whether to show the email below the name (default: false)
   */
  showEmail?: boolean;
  /**
   * Whether to show only the avatar without name/email (default: false)
   */
  avatarOnly?: boolean;
  /**
   * Additional CSS classes
   */
  className?: string;
}

/**
 * User component - displays user avatar and name/email
 *
 * Fetches user data from the API and renders it with proper loading and error states.
 */
export function User({
  id,
  size = "xs",
  showEmail = false,
  avatarOnly = false,
  className,
}: UserProps) {
  const { data: user, isLoading, isError } = useUserById(id);

  // Loading state
  if (isLoading) {
    return (
      <div className={cn("flex items-center gap-2", className)}>
        <Avatar.Skeleton shape="circle" size={size} />
        {!avatarOnly && (
          <div className="flex flex-col gap-1">
            <div className="h-3 w-24 bg-muted animate-pulse rounded" />
            {showEmail && (
              <div className="h-2 w-32 bg-muted animate-pulse rounded" />
            )}
          </div>
        )}
      </div>
    );
  }

  // Error or not found state
  if (isError || !user) {
    return (
      <div className={cn("flex items-center gap-2", className)}>
        <Avatar shape="circle" size={size} fallback="?" muted />
        {!avatarOnly && (
          <div className="flex flex-col">
            <div className="text-sm text-muted-foreground">Unknown User</div>
          </div>
        )}
      </div>
    );
  }

  // Success state
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Avatar
        shape="circle"
        size={size}
        url={user.image ?? undefined}
        fallback={user.name}
      />
      {!avatarOnly && (
        <div className="flex flex-col">
          <div className="text-sm font-medium">{user.name}</div>
          {showEmail && (
            <div className="text-xs text-muted-foreground">{user.email}</div>
          )}
        </div>
      )}
    </div>
  );
}
