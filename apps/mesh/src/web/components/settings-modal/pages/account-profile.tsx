import { useState } from "react";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { Check, Copy01 } from "@untitledui/icons";
import { authClient } from "@/web/lib/auth-client";

export function AccountProfilePage() {
  const { data: session } = authClient.useSession();
  const [copied, setCopied] = useState(false);

  const user = session?.user;
  const userImage = (user as { image?: string } | undefined)?.image;

  const handleCopyUserId = () => {
    if (!user?.id) return;
    navigator.clipboard.writeText(user.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h2 className="text-base font-semibold text-foreground">Profile</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Your account identity on this workspace.
        </p>
      </div>

      <div className="flex items-center gap-4">
        <Avatar
          url={userImage}
          fallback={user?.name ?? "U"}
          shape="circle"
          size="xl"
          className="size-16 shrink-0"
        />
        <div className="flex flex-col gap-1 min-w-0">
          <span className="text-sm font-semibold text-foreground truncate">
            {user?.name ?? "User"}
          </span>
          <span className="text-sm text-muted-foreground truncate">
            {user?.email}
          </span>
        </div>
      </div>

      <div className="border-t border-border pt-6 flex flex-col gap-2">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          User ID
        </p>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleCopyUserId}
                className="group flex items-center gap-2 w-fit text-muted-foreground hover:text-foreground transition-colors"
              >
                <span className="font-mono text-xs">{user?.id}</span>
                {copied ? (
                  <Check size={14} className="text-green-600 shrink-0" />
                ) : (
                  <Copy01
                    size={14}
                    className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                  />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p className="text-xs">Copy user ID</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
}
