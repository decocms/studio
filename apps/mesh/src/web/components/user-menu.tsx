import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import {
  Settings01,
  LogOut01,
  LinkExternal01,
  Copy01,
  Check,
  File06,
  Shield01,
  Users03,
  Globe01,
} from "@untitledui/icons";
import { GitHubIcon } from "@daveyplate/better-auth-ui";
import { authClient } from "@/web/lib/auth-client";
import { useState } from "react";
import { useSettingsModal } from "@/web/hooks/use-settings-modal";
import { toast } from "sonner";

function MeshUserMenuBase({
  user,
  userImage,
}: {
  user: { id: string; name?: string; email: string };
  userImage?: string;
}) {
  const { open: openSettings } = useSettingsModal();
  const [copied, setCopied] = useState(false);

  const handleCopyUserInfo = () => {
    const userInfo = `ID: ${user.id}\nName: ${user.name || "N/A"}\nEmail: ${user.email}`;
    navigator.clipboard.writeText(userInfo);
    setCopied(true);
    toast.success("User info copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex w-full h-8 items-center gap-2 rounded-md px-1 hover:bg-sidebar-accent transition-colors text-left min-w-0">
          <Avatar
            url={userImage}
            fallback={user.name || user.email || "U"}
            shape="circle"
            size="2xs"
            className="shrink-0 size-5"
          />
          <div className="flex-1 min-w-0 group-data-[collapsible=icon]:hidden">
            <div className="text-sm font-medium truncate text-sidebar-foreground leading-none">
              {user.name || "User"}
            </div>
          </div>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="end"
        collisionPadding={8}
        className="w-64 flex flex-col gap-0.5"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {/* User info */}
        <DropdownMenuItem
          onClick={handleCopyUserInfo}
          className="gap-2.5 group"
        >
          <Avatar
            url={userImage}
            fallback={user.name || user.email || "U"}
            shape="circle"
            size="sm"
            className="shrink-0"
          />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">
              {user.name || "User"}
            </div>
            <div className="text-xs text-muted-foreground truncate">
              {user.email}
            </div>
          </div>
          <div className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
            {copied ? (
              <Check size={14} className="text-green-600" />
            ) : (
              <Copy01 size={14} className="text-muted-foreground" />
            )}
          </div>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {/* Main actions */}
        <DropdownMenuItem
          className="gap-2.5"
          onClick={() => openSettings("account.preferences")}
        >
          <Settings01 size={14} className="shrink-0 text-muted-foreground" />
          <span>Settings</span>
        </DropdownMenuItem>

        <DropdownMenuItem asChild>
          <a
            href="https://www.decocms.com/terms-of-use"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2.5 group"
          >
            <File06 size={14} className="shrink-0 text-muted-foreground" />
            <span className="flex-1">Terms of Use</span>
            <LinkExternal01
              size={14}
              className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
            />
          </a>
        </DropdownMenuItem>

        <DropdownMenuItem asChild>
          <a
            href="https://www.decocms.com/privacy-policy"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2.5 group"
          >
            <Shield01 size={14} className="shrink-0 text-muted-foreground" />
            <span className="flex-1">Privacy Policy</span>
            <LinkExternal01
              size={14}
              className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
            />
          </a>
        </DropdownMenuItem>

        <DropdownMenuItem asChild>
          <a
            href="https://github.com/decocms/mesh"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2.5 group"
          >
            <GitHubIcon className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
            <span className="flex-1">decocms/mesh</span>
            <LinkExternal01
              size={14}
              className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
            />
          </a>
        </DropdownMenuItem>

        <DropdownMenuItem asChild>
          <a
            href="https://decocms.com/discord"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2.5 group"
          >
            <Users03 size={14} className="shrink-0 text-muted-foreground" />
            <span className="flex-1">Community</span>
            <LinkExternal01
              size={14}
              className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
            />
          </a>
        </DropdownMenuItem>

        <DropdownMenuItem asChild>
          <a
            href="https://decocms.com"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2.5 group"
          >
            <Globe01 size={14} className="shrink-0 text-muted-foreground" />
            <span className="flex-1">Homepage</span>
            <LinkExternal01
              size={14}
              className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
            />
          </a>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {/* Sign out */}
        <DropdownMenuItem
          className="gap-2.5"
          onClick={() => authClient.signOut()}
        >
          <LogOut01 size={14} className="shrink-0 text-muted-foreground" />
          <span>Sign out</span>
        </DropdownMenuItem>

        <div className="px-2 py-1.5">
          <span className="text-xs text-muted-foreground/60">
            v{__MESH_VERSION__}
          </span>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function MeshUserMenu() {
  const { data: session } = authClient.useSession();

  if (!session?.user) {
    return (
      <Avatar
        url={undefined}
        fallback="U"
        shape="circle"
        size="sm"
        className="cursor-pointer h-7 w-7"
        muted
      />
    );
  }

  const user = session.user;
  const userMenuUser = {
    ...user,
    name: user.name ?? undefined,
  } as typeof user;
  const userImage = (user as { image?: string }).image;

  return <MeshUserMenuBase user={userMenuUser} userImage={userImage} />;
}
