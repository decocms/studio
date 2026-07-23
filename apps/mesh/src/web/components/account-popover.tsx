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
  LinkExternal01,
  LogOut01,
  Monitor01,
  Moon01,
  Settings02,
  Shield01,
  ShieldTick,
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
import { usePreferences, type ThemeMode } from "@/web/hooks/use-preferences.ts";
import { useDeploymentAdmin } from "@/web/hooks/use-deployment-admin";
import { toast } from "@deco/ui/components/sonner.js";
import { useT } from "@/web/i18n/use-t.ts";

interface MenuItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  onClick?: () => void;
  href?: string;
  external?: boolean;
  /** Extra classes for a visually distinct item (e.g. admin / impersonation actions). */
  className?: string;
}

function MenuItemButton({
  item,
  onClose,
}: {
  item: MenuItem;
  onClose: () => void;
}) {
  const baseClass = cn(
    "flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-left w-full transition-colors text-foreground/80 hover:bg-sidebar-accent hover:text-foreground",
    item.className,
  );

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

function ImpersonatingPill() {
  const t = useT();
  return (
    <span className="shrink-0 inline-flex items-center rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning">
      {t("common.accountPopover.impersonating")}
    </span>
  );
}

function UserInfoHeader({
  user,
  userImage,
  isImpersonating,
  isMobile,
}: {
  user: { id?: string; name?: string; email?: string } | undefined;
  userImage?: string;
  isImpersonating: boolean;
  isMobile: boolean;
}) {
  const t = useT();
  return (
    <div
      className={cn(
        "flex items-center gap-3 px-4",
        isMobile ? "py-4 border-b border-border" : "py-3 mx-1 mt-1",
      )}
    >
      <Avatar
        url={userImage}
        fallback={user?.name ?? "U"}
        shape="circle"
        size="sm"
        className="shrink-0"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium truncate">
            {user?.name ?? t("common.accountPopover.defaultUserName")}
          </p>
          {isImpersonating && <ImpersonatingPill />}
        </div>
        <p className="text-xs text-muted-foreground truncate">{user?.email}</p>
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
                  toast.success(t("common.accountPopover.userIdCopied"));
                });
              }}
              className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
            >
              <Copy01 size={14} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">
            <p className="text-xs">{t("common.accountPopover.copyUserId")}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

function ThemeSoundVersionBar({
  themeOptions,
  preferences,
  setPreferences,
  isMobile,
}: {
  themeOptions: { value: ThemeMode; icon: React.ReactNode; label: string }[];
  preferences: ReturnType<typeof usePreferences>[0];
  setPreferences: ReturnType<typeof usePreferences>[1];
  isMobile: boolean;
}) {
  const t = useT();
  const buttonSize = isMobile ? "size-8" : "size-7";

  return (
    <div
      className={cn(
        "flex items-center justify-between border-t border-border/50",
        isMobile ? "px-3 py-3" : "px-2 py-1.5",
      )}
    >
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
              buttonSize,
              "rounded-md flex items-center justify-center transition-colors",
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
            preferences.enableSounds
              ? t("common.accountPopover.disableSounds")
              : t("common.accountPopover.enableSounds")
          }
          onClick={() =>
            setPreferences((prev) => ({
              ...prev,
              enableSounds: !prev.enableSounds,
            }))
          }
          className={cn(
            buttonSize,
            "rounded-md flex items-center justify-center transition-colors",
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
  );
}

/** Shared content rendered inside popover (desktop) or drawer (mobile) */
function AccountPopoverContent({
  user,
  userImage,
  menuItems,
  signOutItem,
  stopImpersonatingItem,
  isImpersonating,
  themeOptions,
  preferences,
  setPreferences,
  close,
  isMobile,
}: {
  user: { id?: string; name?: string; email?: string } | undefined;
  userImage?: string;
  menuItems: MenuItem[];
  signOutItem: MenuItem;
  stopImpersonatingItem: MenuItem | null;
  isImpersonating: boolean;
  themeOptions: { value: ThemeMode; icon: React.ReactNode; label: string }[];
  preferences: ReturnType<typeof usePreferences>[0];
  setPreferences: ReturnType<typeof usePreferences>[1];
  close: () => void;
  isMobile: boolean;
}) {
  if (isMobile) {
    // Mobile: single-column scrollable layout
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <UserInfoHeader
          user={user}
          userImage={userImage}
          isImpersonating={isImpersonating}
          isMobile
        />

        {/* Scrollable content */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {/* Menu items */}
          <nav className="flex flex-col px-2 pt-2 pb-2 gap-0.5">
            {menuItems.map((item) => (
              <MenuItemButton key={item.key} item={item} onClose={close} />
            ))}
            {stopImpersonatingItem && (
              <MenuItemButton item={stopImpersonatingItem} onClose={close} />
            )}
            <MenuItemButton item={signOutItem} onClose={close} />
          </nav>
        </div>

        <ThemeSoundVersionBar
          themeOptions={themeOptions}
          preferences={preferences}
          setPreferences={setPreferences}
          isMobile
        />
      </div>
    );
  }

  // Desktop: single-column account menu (org switching lives in the breadcrumb)
  return (
    <div className="flex w-full flex-col overflow-hidden">
      <div className="flex flex-col">
        <UserInfoHeader
          user={user}
          userImage={userImage}
          isImpersonating={isImpersonating}
          isMobile={false}
        />

        {/* Navigation items */}
        <nav className="flex-1 flex flex-col px-2 pt-1 overflow-y-auto">
          {menuItems.map((item) => (
            <MenuItemButton key={item.key} item={item} onClose={close} />
          ))}
          {stopImpersonatingItem && (
            <MenuItemButton item={stopImpersonatingItem} onClose={close} />
          )}
          <MenuItemButton item={signOutItem} onClose={close} />
        </nav>

        <ThemeSoundVersionBar
          themeOptions={themeOptions}
          preferences={preferences}
          setPreferences={setPreferences}
          isMobile={false}
        />
      </div>
    </div>
  );
}

export function AccountPopover() {
  const t = useT();
  const { data: session } = authClient.useSession();
  // Org context is still read for the "Add to Home Screen" (per-org install) and
  // Preferences deep-links — but org *switching* now lives in the toolbar
  // breadcrumb, so this popover is account-only.
  const { org: currentOrg } = useProjectContext();
  const navigate = useNavigate();
  const orgMatch = useMatch({ from: "/shell/$org", shouldThrow: false });
  const orgParam = orgMatch?.params.org;
  const [preferences, setPreferences] = usePreferences();
  const isMobile = useIsMobile();
  const { isAdmin: isDeploymentAdmin } = useDeploymentAdmin();

  const [open, setOpen] = useState(false);

  const user = session?.user;
  const userImage = (user as { image?: string } | undefined)?.image;
  const isImpersonating = !!(
    session?.session as { impersonatedBy?: string } | undefined
  )?.impersonatedBy;

  const close = () => setOpen(false);

  const menuItems: MenuItem[] = [
    {
      key: "preferences",
      label: t("common.accountPopover.preferences"),
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
            label: t("common.accountPopover.addToHomeScreen"),
            icon: <Download01 size={16} />,
            onClick: () => {
              navigate({
                to: "/$org/install",
                params: { org: currentOrg.slug },
              });
            },
          } satisfies MenuItem,
          // Connect this org's unified MCP to Claude (Code/Desktop) and
          // other MCP clients. Always available inside an org so it's easy
          // to find from anywhere.
          {
            key: "connect-clients",
            label: "Connect to Agents",
            icon: <LinkExternal01 size={16} />,
            onClick: () => {
              navigate({
                to: "/$org/settings/connect",
                params: { org: currentOrg.slug },
              });
            },
          } satisfies MenuItem,
        ]
      : []),
    {
      key: "terms",
      label: t("common.accountPopover.termsOfUse"),
      icon: <File06 size={16} />,
      href: "https://www.decocms.com/terms-of-use",
      external: true,
    },
    {
      key: "privacy",
      label: t("common.accountPopover.privacyPolicy"),
      icon: <Shield01 size={16} />,
      href: "https://www.decocms.com/privacy-policy",
      external: true,
    },
    {
      key: "github",
      label: t("common.accountPopover.githubRepo"),
      icon: <GitHubIcon className="w-4 h-4" />,
      href: "https://github.com/decocms/studio",
      external: true,
    },
    {
      key: "community",
      label: t("common.accountPopover.community"),
      icon: <Users03 size={16} />,
      href: "https://decocms.com/discord",
      external: true,
    },
    {
      key: "homepage",
      label: t("common.accountPopover.homepage"),
      icon: <Globe01 size={16} />,
      href: "https://decocms.com",
      external: true,
    },
    ...(isDeploymentAdmin
      ? [
          {
            key: "admin-dashboard",
            label: t("common.accountPopover.adminDashboard"),
            icon: <ShieldTick size={16} />,
            onClick: () => navigate({ to: "/_admin" }),
            className: "text-warning",
          } satisfies MenuItem,
        ]
      : []),
  ];

  const signOutItem: MenuItem = {
    key: "logout",
    label: t("common.accountPopover.signOut"),
    icon: <LogOut01 size={16} />,
    onClick: () => {
      track("signed_out", { source: "account_popover" });
      clearPersistedQueryCache();
      authClient.signOut();
    },
  };

  // Direct client call — safe anywhere: stopImpersonating needs no admin
  // permission, only the impersonatedBy session + signed admin_session
  // cookie. Must NOT go through /api/_admin (the impersonated user isn't an
  // allowlisted admin). The better-auth client returns { error } instead of
  // throwing, so redirect only on success — otherwise a failed stop would
  // silently reload the admin still impersonating.
  const stopImpersonatingItem: MenuItem | null = isImpersonating
    ? {
        key: "stop-impersonating",
        label: t("common.accountPopover.stopImpersonation"),
        icon: <LogOut01 size={16} />,
        onClick: async () => {
          const { error } = await authClient.admin.stopImpersonating();
          if (error) {
            toast.error(
              error.message ||
                t("common.accountPopover.failedToStopImpersonation"),
            );
            return;
          }
          window.location.href = "/";
        },
        className: "text-warning",
      }
    : null;

  const themeOptions: {
    value: ThemeMode;
    icon: React.ReactNode;
    label: string;
  }[] = [
    {
      value: "light",
      icon: <Sun size={14} />,
      label: t("common.accountPopover.lightTheme"),
    },
    {
      value: "dark",
      icon: <Moon01 size={14} />,
      label: t("common.accountPopover.darkTheme"),
    },
    {
      value: "system",
      icon: <Monitor01 size={14} />,
      label: t("common.accountPopover.systemTheme"),
    },
  ];

  const sharedProps = {
    user,
    userImage,
    menuItems,
    signOutItem,
    stopImpersonatingItem,
    isImpersonating,
    themeOptions,
    preferences,
    setPreferences,
    close,
    isMobile,
  };

  return (
    <>
      {isMobile ? (
        <Drawer open={open} onOpenChange={setOpen} direction="bottom">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className={cn(
              "flex items-center gap-3 w-full px-3 py-2.5 rounded-lg transition-colors text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground",
              isImpersonating && "border-2 border-dashed border-warning",
            )}
          >
            <Avatar
              url={userImage}
              fallback={user?.name ?? "U"}
              shape="circle"
              size="2xs"
              className="shrink-0"
            />
            <span className="truncate">
              {user?.name ?? t("common.accountPopover.defaultAccountLabel")}
            </span>
          </button>
          <DrawerContent className="h-[80dvh] p-0">
            <DrawerTitle className="sr-only">
              {t("common.accountPopover.account")}
            </DrawerTitle>
            <AccountPopoverContent {...sharedProps} />
          </DrawerContent>
        </Drawer>
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <SidebarMenuButton
              tooltip={
                user?.name ?? t("common.accountPopover.defaultAccountLabel")
              }
              className={cn(
                "rounded-md",
                isImpersonating && "border-2 border-dashed border-warning",
              )}
            >
              <Avatar
                url={userImage}
                fallback={user?.name ?? "U"}
                shape="circle"
                size="xs"
                className="shrink-0"
              />
              <span className="truncate">
                {user?.name ?? t("common.accountPopover.defaultAccountLabel")}
              </span>
            </SidebarMenuButton>
          </PopoverTrigger>

          <PopoverContent
            side="right"
            align="end"
            sideOffset={18}
            collisionPadding={16}
            className="w-[280px] p-0 flex flex-col max-h-[520px]"
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            <AccountPopoverContent {...sharedProps} />
          </PopoverContent>
        </Popover>
      )}
    </>
  );
}
