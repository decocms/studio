import { useState } from "react";
import { useNavigate, useMatch } from "@tanstack/react-router";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
} from "@deco/ui/components/drawer.tsx";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import {
  Copy01,
  Download01,
  File06,
  Globe01,
  LogOut01,
  Monitor01,
  Moon01,
  Settings02,
  Shield01,
  Sun,
  Users03,
  VolumeMax,
  VolumeX,
} from "@untitledui/icons";
import { GitHubIcon } from "@daveyplate/better-auth-ui";
import { SidebarMenuButton } from "@deco/ui/components/sidebar.tsx";
import { authClient } from "@/web/lib/auth-client";
import { useProjectContext } from "@decocms/mesh-sdk";
import { track } from "@/web/lib/posthog-client";
import { clearPersistedQueryCache } from "@/web/lib/query-persist";
import { CreateOrganizationDialog } from "@/web/components/create-organization-dialog";
import {
  getOrgColorStyle,
  OrganizationsPanel,
} from "@/web/components/header/org-switcher";
import { usePreferences, type ThemeMode } from "@/web/hooks/use-preferences.ts";
import { toast } from "@deco/ui/components/sonner.js";

interface MenuItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  onClick?: () => void;
  href?: string;
  external?: boolean;
}

function MenuItemButton({
  item,
  onClose,
}: {
  item: MenuItem;
  onClose: () => void;
}) {
  const baseClass =
    "flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-left w-full transition-colors text-foreground/80 hover:bg-sidebar-accent hover:text-foreground";

  if (item.href) {
    return (
      <a
        href={item.href}
        target={item.external ? "_blank" : undefined}
        rel={item.external ? "noopener noreferrer" : undefined}
        className={baseClass}
        onClick={onClose}
      >
        <span className="shrink-0 text-muted-foreground">{item.icon}</span>
        <span className="flex-1">{item.label}</span>
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        item.onClick?.();
        onClose();
      }}
      className={baseClass}
    >
      <span className="shrink-0 text-muted-foreground">{item.icon}</span>
      <span className="flex-1">{item.label}</span>
    </button>
  );
}

/** Shared content rendered inside popover (desktop) or drawer (mobile) */
function AccountPopoverContent({
  user,
  userImage,
  menuItems,
  signOutItem,
  themeOptions,
  preferences,
  setPreferences,
  orgParam,
  onSelectOrg,
  onCreateOrg,
  close,
  isMobile,
  open,
}: {
  user: { id?: string; name?: string; email?: string } | undefined;
  userImage?: string;
  menuItems: MenuItem[];
  signOutItem: MenuItem;
  themeOptions: { value: ThemeMode; icon: React.ReactNode; label: string }[];
  preferences: ReturnType<typeof usePreferences>[0];
  setPreferences: ReturnType<typeof usePreferences>[1];
  orgParam?: string;
  onSelectOrg: (slug: string) => void;
  onCreateOrg: () => void;
  close: () => void;
  isMobile: boolean;
  open: boolean;
}) {
  if (isMobile) {
    // Mobile: single-column scrollable layout
    return (
      <div className="flex flex-col h-full overflow-hidden">
        {/* User info */}
        <div className="flex items-center gap-3 px-4 py-4 border-b border-border">
          <Avatar
            url={userImage}
            fallback={user?.name ?? "U"}
            shape="circle"
            size="sm"
            className="shrink-0"
          />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">
              {user?.name ?? "User"}
            </p>
            <p className="text-xs text-muted-foreground truncate">
              {user?.email}
            </p>
          </div>
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => {
                    if (!user?.id) return;
                    navigator.clipboard.writeText(user.id).then(() => {
                      toast.success("User ID copied");
                    });
                  }}
                  className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Copy01 size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">
                <p className="text-xs">Copy user ID</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {/* Org switcher */}
          <div className="border-b border-border pb-2">
            <OrganizationsPanel
              key={String(open)}
              orgParam={orgParam}
              onSelectOrg={onSelectOrg}
              onCreateOrg={onCreateOrg}
            />
          </div>

          {/* Menu items */}
          <nav className="flex flex-col px-2 pt-2 pb-2 gap-0.5">
            {menuItems.map((item) => (
              <MenuItemButton key={item.key} item={item} onClose={close} />
            ))}
            <MenuItemButton item={signOutItem} onClose={close} />
          </nav>
        </div>

        {/* Bottom bar: theme + sound + version */}
        <div className="flex items-center justify-between px-3 py-3 border-t border-border/50">
          <div className="flex items-center gap-0.5">
            {themeOptions.map(({ value, icon, label }) => (
              <button
                key={value}
                type="button"
                aria-label={label}
                onClick={() =>
                  setPreferences((prev) => ({ ...prev, theme: value }))
                }
                className={cn(
                  "size-8 rounded-md flex items-center justify-center transition-colors",
                  preferences.theme === value
                    ? "bg-sidebar-accent text-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
                )}
              >
                {icon}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label={
                preferences.enableSounds ? "Disable sounds" : "Enable sounds"
              }
              onClick={() =>
                setPreferences((prev) => ({
                  ...prev,
                  enableSounds: !prev.enableSounds,
                }))
              }
              className={cn(
                "size-8 rounded-md flex items-center justify-center transition-colors",
                preferences.enableSounds
                  ? "text-foreground hover:bg-sidebar-accent/50"
                  : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
              )}
            >
              {preferences.enableSounds ? (
                <VolumeMax size={14} />
              ) : (
                <VolumeX size={14} />
              )}
            </button>
            <span className="text-xs text-muted-foreground/60">
              v{__MESH_VERSION__}
            </span>
          </div>
        </div>
      </div>
    );
  }

  // Desktop: two-column layout
  return (
    <div className="flex min-h-[380px] w-full overflow-hidden">
      {/* Left panel */}
      <div className="w-60 shrink-0 flex flex-col border-r border-border bg-sidebar/75">
        {/* User info */}
        <div className="flex items-center gap-3 px-4 py-3 mx-1 mt-1">
          <Avatar
            url={userImage}
            fallback={user?.name ?? "U"}
            shape="circle"
            size="sm"
            className="shrink-0"
          />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">
              {user?.name ?? "User"}
            </p>
            <p className="text-xs text-muted-foreground truncate">
              {user?.email}
            </p>
          </div>
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => {
                    if (!user?.id) return;
                    navigator.clipboard.writeText(user.id).then(() => {
                      toast.success("User ID copied");
                    });
                  }}
                  className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Copy01 size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">
                <p className="text-xs">Copy user ID</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>

        {/* Navigation items */}
        <nav className="flex-1 flex flex-col px-2 pt-1 overflow-y-auto">
          {menuItems.map((item) => (
            <MenuItemButton key={item.key} item={item} onClose={close} />
          ))}
          <MenuItemButton item={signOutItem} onClose={close} />
        </nav>

        {/* Bottom bar: theme toggles + sound + version */}
        <div className="flex items-center justify-between px-2 py-1.5 border-t border-border/50">
          <div className="flex items-center gap-0.5">
            {themeOptions.map(({ value, icon, label }) => (
              <button
                key={value}
                type="button"
                aria-label={label}
                onClick={() =>
                  setPreferences((prev) => ({ ...prev, theme: value }))
                }
                className={cn(
                  "size-7 rounded-md flex items-center justify-center transition-colors",
                  preferences.theme === value
                    ? "bg-sidebar-accent text-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
                )}
              >
                {icon}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label={
                preferences.enableSounds ? "Disable sounds" : "Enable sounds"
              }
              onClick={() =>
                setPreferences((prev) => ({
                  ...prev,
                  enableSounds: !prev.enableSounds,
                }))
              }
              className={cn(
                "size-7 rounded-md flex items-center justify-center transition-colors",
                preferences.enableSounds
                  ? "text-foreground hover:bg-sidebar-accent/50"
                  : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
              )}
            >
              {preferences.enableSounds ? (
                <VolumeMax size={14} />
              ) : (
                <VolumeX size={14} />
              )}
            </button>
            <span className="text-xs text-muted-foreground/60">
              v{__MESH_VERSION__}
            </span>
          </div>
        </div>
      </div>

      {/* Right panel - org selector */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
        <OrganizationsPanel
          key={String(open)}
          orgParam={orgParam}
          onSelectOrg={onSelectOrg}
          onCreateOrg={onCreateOrg}
        />
      </div>
    </div>
  );
}

export function AccountPopover() {
  const { data: session } = authClient.useSession();
  // Current org comes from the already-loaded shell context (name + logo) so
  // the trigger paints without fetching organization.list. The full list is
  // fetched lazily inside OrganizationsPanel when the switcher opens.
  const { org: currentOrg } = useProjectContext();
  const navigate = useNavigate();
  const orgMatch = useMatch({ from: "/shell/$org", shouldThrow: false });
  const orgParam = orgMatch?.params.org;
  const [preferences, setPreferences] = usePreferences();
  const isMobile = useIsMobile();

  const [open, setOpen] = useState(false);
  const [creatingOrg, setCreatingOrg] = useState(false);

  const user = session?.user;
  const userImage = (user as { image?: string } | undefined)?.image;

  const handleSelectOrg = (orgSlug: string) => {
    setOpen(false);
    navigate({
      to: "/$org",
      params: { org: orgSlug },
    });
  };

  const close = () => setOpen(false);

  const menuItems: MenuItem[] = [
    {
      key: "preferences",
      label: "Preferences",
      icon: <Settings02 size={16} />,
      onClick: () => {
        navigate({
          to: "/$org/settings/profile",
          params: { org: orgParam ?? "" },
        });
      },
    },
    // Per-org install: opens the org install page, which swaps to an
    // org-branded manifest so installing produces a home-screen app for this
    // org. (Studio itself installs via the browser's native "Add to Home
    // Screen".) Only shown while inside an org.
    ...(currentOrg
      ? [
          {
            key: "install-app",
            label: "Add to Home Screen",
            icon: <Download01 size={16} />,
            onClick: () => {
              navigate({
                to: "/$org/install",
                params: { org: currentOrg.slug },
              });
            },
          } satisfies MenuItem,
        ]
      : []),
    {
      key: "terms",
      label: "Terms of Use",
      icon: <File06 size={16} />,
      href: "https://www.decocms.com/terms-of-use",
      external: true,
    },
    {
      key: "privacy",
      label: "Privacy Policy",
      icon: <Shield01 size={16} />,
      href: "https://www.decocms.com/privacy-policy",
      external: true,
    },
    {
      key: "github",
      label: "decocms/studio",
      icon: <GitHubIcon className="w-4 h-4" />,
      href: "https://github.com/decocms/studio",
      external: true,
    },
    {
      key: "community",
      label: "Community",
      icon: <Users03 size={16} />,
      href: "https://decocms.com/discord",
      external: true,
    },
    {
      key: "homepage",
      label: "Homepage",
      icon: <Globe01 size={16} />,
      href: "https://decocms.com",
      external: true,
    },
  ];

  const signOutItem: MenuItem = {
    key: "logout",
    label: "Sign out",
    icon: <LogOut01 size={16} />,
    onClick: () => {
      track("signed_out", { source: "account_popover" });
      clearPersistedQueryCache();
      authClient.signOut();
    },
  };

  const themeOptions: {
    value: ThemeMode;
    icon: React.ReactNode;
    label: string;
  }[] = [
    { value: "light", icon: <Sun size={14} />, label: "Light theme" },
    { value: "dark", icon: <Moon01 size={14} />, label: "Dark theme" },
    { value: "system", icon: <Monitor01 size={14} />, label: "System theme" },
  ];

  const sharedProps = {
    user,
    userImage,
    menuItems,
    signOutItem,
    themeOptions,
    preferences,
    setPreferences,
    orgParam,
    onSelectOrg: handleSelectOrg,
    onCreateOrg: () => {
      setOpen(false);
      setCreatingOrg(true);
    },
    close,
    isMobile,
    open,
  };

  return (
    <>
      {isMobile ? (
        <Drawer open={open} onOpenChange={setOpen} direction="bottom">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg transition-colors text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <div
              className="shrink-0 size-5 rounded-md flex items-center justify-center border border-border/50 overflow-hidden"
              style={
                currentOrg?.logo
                  ? undefined
                  : getOrgColorStyle(currentOrg?.name ?? "")
              }
            >
              {currentOrg?.logo ? (
                <img
                  src={currentOrg.logo}
                  alt=""
                  className="size-full object-cover"
                />
              ) : (
                <span className="font-semibold leading-none text-[8px]">
                  {(currentOrg?.name ?? "?").slice(0, 2).toUpperCase()}
                </span>
              )}
            </div>
            <span className="truncate">{currentOrg?.name ?? "Account"}</span>
          </button>
          <DrawerContent className="h-[80dvh] p-0">
            <DrawerTitle className="sr-only">Account</DrawerTitle>
            <AccountPopoverContent {...sharedProps} />
          </DrawerContent>
        </Drawer>
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <SidebarMenuButton
              tooltip={currentOrg?.name ?? "Account"}
              className="rounded-md"
            >
              <div
                className="shrink-0 size-6 rounded-md flex items-center justify-center border border-border/50 overflow-hidden"
                style={
                  currentOrg?.logo
                    ? undefined
                    : getOrgColorStyle(currentOrg?.name ?? "")
                }
              >
                {currentOrg?.logo ? (
                  <img
                    src={currentOrg.logo}
                    alt=""
                    className="size-full object-cover"
                  />
                ) : (
                  <span className="font-semibold leading-none text-[9px]">
                    {(currentOrg?.name ?? "?").slice(0, 2).toUpperCase()}
                  </span>
                )}
              </div>
              <span className="truncate">{currentOrg?.name ?? "Account"}</span>
            </SidebarMenuButton>
          </PopoverTrigger>

          <PopoverContent
            side="right"
            align="end"
            sideOffset={18}
            collisionPadding={16}
            className="w-[520px] p-0 flex max-h-[520px]"
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            <AccountPopoverContent {...sharedProps} />
          </PopoverContent>
        </Popover>
      )}

      <CreateOrganizationDialog
        open={creatingOrg}
        onOpenChange={setCreatingOrg}
      />
    </>
  );
}
