/** The settings sidebar: what the settings tree puts in `SidebarShell`'s four
 *  slots, on desktop and in the mobile sheet. It is the same shell, the same
 *  header and the same row primitive the org sidebar uses — settings should
 *  read as the same product, not a place you were teleported to. */

import { type ReactNode, useState } from "react";
import { ChevronDown, ChevronRight, LogOut01 } from "@untitledui/icons";
import { SidebarMenu } from "@decocms/ui/components/sidebar.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { authClient } from "@/lib/auth-client";
import { track } from "@/lib/posthog-client";
import { clearPersistedQueryCache } from "@/lib/query-persist";
import { useProjectContext } from "@/sdk";
import { SidebarPickerHeaderMobile } from "./header";
import { SidebarBackRow, SidebarNavRow } from "./nav-row";
import {
  type SettingsNavGroup,
  useIsActiveSettingsPath,
  useSettingsSidebarGroups,
} from "./settings-nav-items";
import { SidebarShell } from "./shell";

/** Open/closed state for the collapsible groups. A group starts open when it
 *  holds the page you're on, so a deep link into Advanced never lands you in a
 *  closed drawer. */
function useGroupDisclosure() {
  const { isActive } = useIsActiveSettingsPath();
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  const isOpen = (group: SettingsNavGroup) =>
    overrides[group.key] ?? (!group.collapsible || group.items.some(isActive));

  const toggle = (group: SettingsNavGroup) =>
    setOverrides((prev) => ({ ...prev, [group.key]: !isOpen(group) }));

  return { isOpen, toggle };
}

/** A group heading — plain text for the fixed groups, a chevron button for the
 *  collapsible one. */
function SettingsGroupHeading({
  group,
  open,
  onToggle,
  className,
}: {
  group: SettingsNavGroup;
  open: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const style = cn(
    "text-xs font-medium text-muted-foreground/60 truncate",
    className,
  );

  if (!group.collapsible) {
    return <p className={style}>{group.label}</p>;
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={cn(
        "flex w-full items-center gap-1 rounded-md hover:text-muted-foreground",
        style,
      )}
    >
      {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      <span className="truncate">{group.label}</span>
    </button>
  );
}

/** The item icon, with the small notification dot a row can carry. It goes in
 *  the row's `icon` slot rather than after the label, because the rail hides
 *  exactly `span:last-child` — see `nav-row.tsx`. */
function SettingsNavIcon({ icon, badge }: { icon: ReactNode; badge?: number }) {
  return (
    <span className="relative shrink-0">
      {icon}
      {badge ? (
        <span className="absolute -right-1 -top-1 size-2 rounded-full bg-destructive pointer-events-none" />
      ) : null}
    </span>
  );
}

/** The groups, then Sign Out pinned to the bottom away from the Advanced
 *  disclosure. A fragment, so both stay direct children of the shell's body and
 *  `mt-auto` has the shell's free space to push against. */
export function SettingsNav({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();
  const groups = useSettingsSidebarGroups();
  const { org, isActive } = useIsActiveSettingsPath();
  const { isOpen, toggle } = useGroupDisclosure();

  return (
    <>
      {groups.map((group, i) => (
        <div key={group.key} className="flex flex-col">
          {group.label && (
            <SettingsGroupHeading
              group={group}
              open={isOpen(group)}
              onToggle={() => toggle(group)}
              className={cn("px-2 pt-1.5 pb-0.5", i > 0 && "mt-3")}
            />
          )}
          {isOpen(group) && (
            <SidebarMenu className="gap-0.5">
              {group.items.map((item) => (
                <SidebarNavRow
                  key={item.key}
                  icon={<SettingsNavIcon icon={item.icon} badge={item.badge} />}
                  label={item.label}
                  isActive={isActive(item)}
                  link={{ to: item.to, params: { org } }}
                  className="gap-2.5"
                  onSelect={() => {
                    /** Stable keys, not labels — labels are localized. */
                    track("settings_nav_clicked", {
                      section_key: item.key,
                      group_key: group.key,
                    });
                    onNavigate?.();
                  }}
                />
              ))}
            </SidebarMenu>
          )}
        </div>
      ))}

      <div className="mt-auto flex flex-col">
        <div className="mx-2 my-2 border-t border-border/50" />
        <SidebarMenu className="gap-0.5">
          <SidebarNavRow
            icon={
              <span className="shrink-0">
                <LogOut01 size={14} />
              </span>
            }
            label={t("settings.nav.signOut")}
            className="gap-2.5"
            onSelect={() => {
              track("signed_out", { source: "settings_sidebar" });
              clearPersistedQueryCache();
              authClient.signOut();
            }}
          />
        </SidebarMenu>
      </div>
    </>
  );
}

/** The way out of settings.
 *  Settings is its own route tree with its own sidebar, so none of the org's
 *  destinations are reachable from inside it — without this the only exit is
 *  the browser's back button. Lands on the org's home rather than the page you
 *  came from: nothing records that, and inventing it would send you somewhere
 *  you did not ask for. */
export function SettingsBackRow({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();
  const { org } = useProjectContext();

  return (
    <SidebarBackRow
      /** Names where it LANDS, not the org — the picker directly above already
       *  says the org, so "Back to Acme" under a header reading "Acme" was a
       *  row that said nothing twice. */
      label={t("settings.nav.backToHome")}
      /** A real anchor here: leaving settings always lands on the org's home,
       *  so it is a URL and middle-click should honour it. */
      link={{ to: "/$org/home", params: { org: org.slug } }}
      onSelect={onNavigate}
    />
  );
}

export function SettingsVersion() {
  return (
    <div className="px-4 pb-1">
      <span className="text-xs text-muted-foreground/50">
        v{__STUDIO_VERSION__}
      </span>
    </div>
  );
}

/** The mobile sheet: the same four slots as desktop, with the shared mobile
 *  header strip — the SAME picker, so org and project can be switched from
 *  settings exactly as from anywhere else, and a close button in place of the
 *  desktop collapse toggle. It carries no agent switcher: that reads the thread
 *  manager, which this route tree does not mount.
 *
 *  The back row is NOT optional here. Settings is its own route tree, so none
 *  of the org's destinations are reachable from inside it, and the toolbar this
 *  sheet hangs off carries only the hamburger — without this row a phone can
 *  leave settings only with the browser's back button. */
export function SettingsSidebarMobile({ onClose }: { onClose: () => void }) {
  return (
    <SidebarShell
      sheet
      header={<SidebarPickerHeaderMobile onClose={onClose} />}
      back={<SettingsBackRow onNavigate={onClose} />}
      body={<SettingsNav onNavigate={onClose} />}
      footer={<SettingsVersion />}
    />
  );
}
