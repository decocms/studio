import type { ComponentType, SVGProps } from "react";
import {
  GitBranch01,
  Globe01,
  LayoutAlt04,
  Lightning01,
  Terminal,
} from "@untitledui/icons";
import { getIconComponent, parseIconString } from "../../components/agent-icon";

export type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

export type TabKind = "system" | "agent" | "expanded";

export type TabIcon =
  | { kind: "component"; Component: IconComponent }
  | { kind: "url"; src: string }
  | { kind: "fallback" };

export type SystemTabId =
  | "settings"
  | "automations"
  | "env"
  | "preview"
  | "git";

export const SYSTEM_TAB_ICONS: Record<SystemTabId, IconComponent> = {
  settings: LayoutAlt04,
  automations: Lightning01,
  env: Terminal,
  preview: Globe01,
  git: GitBranch01,
};

type ConnectionLike = { id: string; icon: string | null };

/**
 * Convert an icon string (icon://Name or plain URL) to a TabIcon, or null
 * if unresolvable. Handles the @untitledui/icons "icon://" scheme used by
 * pinned views and connection entities.
 */
function toTabIcon(icon: string | null | undefined): TabIcon | null {
  const parsed = parseIconString(icon);
  if (parsed.type === "icon") {
    const Component = getIconComponent(parsed.name);
    if (Component) return { kind: "component", Component };
    return null;
  }
  if (parsed.type === "url") return { kind: "url", src: parsed.url };
  return null;
}

/**
 * Compute the `TabIcon` for a tab.
 *
 * - system: look up the hardcoded mapping from tabId.
 * - agent / expanded: prefer an explicit `iconUrl` (e.g. pinned view's own
 *   icon), otherwise look up the connection by appId and use its icon; else
 *   fall back. Icon strings may be either "icon://<Name>" or a raw URL.
 */
export function resolveTabIcon(args: {
  tabId: string;
  kind: TabKind;
  appId?: string;
  iconUrl?: string | null;
  connections: ConnectionLike[];
}): TabIcon {
  if (args.kind === "system") {
    const Component = SYSTEM_TAB_ICONS[args.tabId as SystemTabId];
    return { kind: "component", Component };
  }

  const fromExplicit = toTabIcon(args.iconUrl);
  if (fromExplicit) return fromExplicit;

  if (!args.appId) return { kind: "fallback" };
  const conn = args.connections.find((c) => c.id === args.appId);
  if (!conn) return { kind: "fallback" };

  const fromConn = toTabIcon(conn.icon);
  if (fromConn) return fromConn;

  return { kind: "fallback" };
}
