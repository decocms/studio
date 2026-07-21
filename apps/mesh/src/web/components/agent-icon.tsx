/**
 * Agent Icon System
 *
 * Renders agent avatars as colored background + icon, custom image, or
 * deterministic fallback (color + first letter).
 *
 * Icon format stored in the `icon` string field:
 *   - "icon://IconName?color=emerald" → colored icon
 *   - URL string → custom image
 *   - null → deterministic fallback
 */

import { cn } from "@deco/ui/lib/utils.ts";
import * as AllIcons from "@untitledui/icons";
import { useState, type ComponentType, type SVGProps } from "react";

// ---------------------------------------------------------------------------
// Color palette (semantic design-system tokens)
// ---------------------------------------------------------------------------

export interface AgentIconColor {
  name: string;
  bg: string; // bg-{semantic-token}
  text: string; // text-{semantic-token}
  dot: string; // bg-{semantic-token} (for picker dots)
}

export const AGENT_ICON_COLORS: AgentIconColor[] = [
  {
    name: "chart-1",
    bg: "bg-chart-1",
    text: "text-chart-1",
    dot: "bg-chart-1",
  },
  {
    name: "chart-2",
    bg: "bg-chart-2",
    text: "text-chart-2",
    dot: "bg-chart-2",
  },
  {
    name: "chart-3",
    bg: "bg-chart-3",
    text: "text-chart-3",
    dot: "bg-chart-3",
  },
  {
    name: "chart-4",
    bg: "bg-chart-4",
    text: "text-chart-4",
    dot: "bg-chart-4",
  },
  {
    name: "chart-5",
    bg: "bg-chart-5",
    text: "text-chart-5",
    dot: "bg-chart-5",
  },
  {
    name: "success",
    bg: "bg-success",
    text: "text-success",
    dot: "bg-success",
  },
  {
    name: "destructive",
    bg: "bg-destructive",
    text: "text-destructive",
    dot: "bg-destructive",
  },
];

const COLOR_MAP = new Map(AGENT_ICON_COLORS.map((c) => [c.name, c]));

export function getIconColor(name: string): AgentIconColor {
  return COLOR_MAP.get(name) ?? AGENT_ICON_COLORS[0]!;
}

// ---------------------------------------------------------------------------
// Icon registry (all @untitledui/icons)
// ---------------------------------------------------------------------------

type IconComponent = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

const ICON_MAP: Record<string, IconComponent> = {};
let iconNames: string[] | null = null;

// Build registry from the namespace import — runs once on first access
function ensureRegistry() {
  if (iconNames) return;
  const entries = Object.entries(AllIcons);
  for (const [name, value] of entries) {
    if (typeof value === "function") {
      ICON_MAP[name] = value as IconComponent;
    }
  }
  iconNames = Object.keys(ICON_MAP).sort();
}

export function getIconComponent(name: string): IconComponent | undefined {
  ensureRegistry();
  return ICON_MAP[name];
}

export function getIconNames(): string[] {
  ensureRegistry();
  return iconNames!;
}

// ---------------------------------------------------------------------------
// Parse / build icon strings
// ---------------------------------------------------------------------------

export type ParsedIcon =
  | { type: "icon"; name: string; color: string }
  | { type: "url"; url: string; color?: string }
  | { type: "fallback" };

export function parseIconString(icon: string | null | undefined): ParsedIcon {
  if (!icon) return { type: "fallback" };

  if (icon.startsWith("icon://")) {
    const rest = icon.slice(7); // after "icon://"
    const qIndex = rest.indexOf("?");
    const name = qIndex >= 0 ? rest.slice(0, qIndex) : rest;
    const params =
      qIndex >= 0 ? new URLSearchParams(rest.slice(qIndex + 1)) : null;
    const color = params?.get("color") ?? "chart-1";
    return { type: "icon", name, color };
  }

  // Extract color from hash fragment: url#agentcolor=blue
  const hashIdx = icon.lastIndexOf("#agentcolor=");
  if (hashIdx >= 0) {
    const color = icon.slice(hashIdx + "#agentcolor=".length);
    const url = icon.slice(0, hashIdx);
    return { type: "url", url, color };
  }

  return { type: "url", url: icon };
}

/** Build an icon:// string with color */
export function buildIconString(name: string, color: string): string {
  return `icon://${name}?color=${color}`;
}

/** Build an image URL with color encoded in hash fragment */
export function buildImageIconString(url: string, color: string): string {
  // Strip any existing agentcolor hash first
  const hashIdx = url.lastIndexOf("#agentcolor=");
  const cleanUrl = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  return `${cleanUrl}#agentcolor=${color}`;
}

// ---------------------------------------------------------------------------
// Humanize icon names for search
// ---------------------------------------------------------------------------

/**
 * Get a deterministic icon component from the registry based on a name hash.
 * Used as fallback when no icon is explicitly set.
 */
function getDeterministicIcon(name: string): {
  IconComp: IconComponent;
  color: AgentIconColor;
} {
  const hash = hashString(name);
  const names = getIconNames();
  const colorIndex = hash % AGENT_ICON_COLORS.length;
  const iconIndex = hash % names.length;
  return {
    IconComp: getIconComponent(names[iconIndex]!)!,
    color: AGENT_ICON_COLORS[colorIndex]!,
  };
}

/** Convert PascalCase to space-separated lowercase: "SearchMd" → "search md" */
export function humanizeIconName(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/(\d+)/g, " $1 ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Hash utility
// ---------------------------------------------------------------------------

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = input.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash);
}

// ---------------------------------------------------------------------------
// Size config
// ---------------------------------------------------------------------------

const SIZES = {
  "2xs": {
    container: "w-5 h-5",
    icon: 12,
    text: "text-[9px]",
    radius: "rounded-md",
  },
  xs: { container: "w-6 h-6", icon: 14, text: "text-xs", radius: "rounded-md" },
  sm: { container: "w-8 h-8", icon: 16, text: "text-sm", radius: "rounded-lg" },
  "sm+": {
    container: "w-10 h-10",
    icon: 20,
    text: "text-base",
    radius: "rounded-lg",
  },
  md: {
    container: "w-12 h-12",
    icon: 24,
    text: "text-xl",
    radius: "rounded-xl",
  },
  lg: {
    container: "w-16 h-16",
    icon: 32,
    text: "text-3xl",
    radius: "rounded-2xl",
  },
  xl: {
    container: "w-20 h-20",
    icon: 40,
    text: "text-4xl",
    radius: "rounded-2xl",
  },
} as const;

export type AgentAvatarSize = keyof typeof SIZES;

// ---------------------------------------------------------------------------
// AgentAvatar
// ---------------------------------------------------------------------------

interface AgentAvatarProps {
  icon: string | null | undefined;
  name: string;
  size?: AgentAvatarSize;
  className?: string;
}

/** Colored background + centered icon — shared by all icon-rendering paths. */
function IconAvatar({
  Icon,
  color,
  size,
  className,
}: {
  Icon: IconComponent;
  color: AgentIconColor;
  size: AgentAvatarSize;
  className?: string;
}) {
  const sizeConfig = SIZES[size];
  return (
    <div
      className={cn(
        sizeConfig.container,
        sizeConfig.radius,
        color.bg,
        color.text,
        "flex items-center justify-center shrink-0 outline-none ring-0 shadow-none",
        className,
      )}
    >
      <Icon size={sizeConfig.icon} />
    </div>
  );
}

export function AgentAvatar({
  icon,
  name,
  size = "md",
  className,
}: AgentAvatarProps) {
  const parsed = parseIconString(icon);

  if (parsed.type === "icon") {
    const IconComp = getIconComponent(parsed.name);
    const color = getIconColor(parsed.color);
    const Icon = IconComp ?? getDeterministicIcon(name).IconComp;

    return (
      <IconAvatar Icon={Icon} color={color} size={size} className={className} />
    );
  }

  if (parsed.type === "url") {
    return (
      <AgentAvatarImage
        url={parsed.url}
        color={parsed.color}
        name={name}
        size={size}
        className={className}
      />
    );
  }

  // Fallback: deterministic color + icon
  const { IconComp, color } = getDeterministicIcon(name);

  return (
    <IconAvatar
      Icon={IconComp}
      color={color}
      size={size}
      className={className}
    />
  );
}

// ---------------------------------------------------------------------------
// Image sub-component (handles load errors)
// ---------------------------------------------------------------------------

const URL_COLOR_BG: Record<string, string> = {
  "brand-green": "bg-[var(--brand-green-light)]",
};

function AgentAvatarImage({
  url,
  color,
  name,
  size = "md",
  className,
}: {
  url: string;
  color?: string;
  name: string;
  size?: AgentAvatarSize;
  className?: string;
}) {
  const [errored, setErrored] = useState(false);
  const sizeConfig = SIZES[size];
  const bgClass = color ? (URL_COLOR_BG[color] ?? "") : "";

  if (errored) {
    const { IconComp, color } = getDeterministicIcon(name);
    return (
      <IconAvatar
        Icon={IconComp}
        color={color}
        size={size}
        className={className}
      />
    );
  }

  return (
    <div
      className={cn(
        sizeConfig.container,
        sizeConfig.radius,
        bgClass,
        "shrink-0 overflow-hidden outline-none ring-0 shadow-none",
        className,
      )}
    >
      <img
        src={url}
        alt={name}
        className={cn(
          "h-full w-full",
          bgClass ? "object-contain p-3" : "object-cover",
        )}
        onError={() => setErrored(true)}
      />
    </div>
  );
}
