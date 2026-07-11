/**
 * AccountMenu — a compact, org-less account affordance for the MY deco home.
 *
 * The sidebar-footer AccountPopover needs an active org (current-org display,
 * per-org install, settings deep-links). The home is org-less, so this is a
 * trimmed menu: identity, theme, and sign out. Switching org happens by opening
 * a thread (which lands in its org) or via the breadcrumb once inside.
 */
import { useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { LogOut01, Monitor01, Moon01, Sun } from "@untitledui/icons";
import { authClient } from "@/web/lib/auth-client";
import { track } from "@/web/lib/posthog-client";
import { clearPersistedQueryCache } from "@/web/lib/query-persist";
import { usePreferences, type ThemeMode } from "@/web/hooks/use-preferences.ts";

const THEME_OPTIONS: { value: ThemeMode; icon: typeof Sun; label: string }[] = [
  { value: "light", icon: Sun, label: "Light theme" },
  { value: "dark", icon: Moon01, label: "Dark theme" },
  { value: "system", icon: Monitor01, label: "System theme" },
];

export function AccountMenu() {
  const { data: session } = authClient.useSession();
  const [preferences, setPreferences] = usePreferences();
  const [open, setOpen] = useState(false);

  const user = session?.user;
  const userImage = (user as { image?: string } | undefined)?.image;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          aria-label="Account"
        >
          <Avatar
            url={userImage}
            fallback={user?.name ?? "U"}
            shape="circle"
            size="sm"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-64 p-0">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
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
        </div>

        <div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
          <span className="text-xs text-muted-foreground">Theme</span>
          <div className="flex items-center gap-0.5">
            {THEME_OPTIONS.map(({ value, icon: Icon, label }) => (
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
                <Icon size={14} />
              </button>
            ))}
          </div>
        </div>

        <div className="p-1.5">
          <button
            type="button"
            onClick={() => {
              track("signed_out", { source: "my_deco_account_menu" });
              clearPersistedQueryCache();
              authClient.signOut();
            }}
            className="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-left w-full transition-colors text-foreground/80 hover:bg-sidebar-accent hover:text-foreground"
          >
            <LogOut01 size={16} className="text-muted-foreground" />
            Sign out
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
