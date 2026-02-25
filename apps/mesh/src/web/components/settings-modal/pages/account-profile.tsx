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

      <div className="flex flex-col">
        <p className="py-4 text-base font-semibold text-foreground border-b border-border">
          User ID
        </p>
        <div className="flex items-center justify-between gap-6 py-4">
          <p className="text-sm text-muted-foreground">User ID</p>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleCopyUserId}
                  className="group flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <span className="font-mono text-sm">{user?.id}</span>
                  {copied ? (
                    <Check size={14} className="text-green-600 shrink-0" />
                  ) : (
                    <Copy01
                      size={14}
                      className="shrink-0 opacity-70 group-hover:opacity-100 transition-opacity"
                    />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">
                <p className="text-xs">Copy user ID</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
    </div>
  );
}
