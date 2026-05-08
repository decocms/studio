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
// Color palette
// ---------------------------------------------------------------------------

export interface AgentIconColor {
  name: string;
  bg: string; // bg-{color}-100
  text: string; // text-{color}-600
  dot: string; // bg-{color}-400 (for picker dots)
}

export const AGENT_ICON_COLORS: AgentIconColor[] = [
  {
    name: "red",
    bg: "bg-red-100 dark:bg-red-950/60",
    text: "text-red-600 dark:text-red-400",
    dot: "bg-red-400",
  },
  {
    name: "orange",
    bg: "bg-orange-100 dark:bg-orange-950/60",
    text: "text-orange-600 dark:text-orange-400",
    dot: "bg-orange-400",
  },
  {
    name: "amber",
    bg: "bg-amber-100 dark:bg-amber-950/60",
    text: "text-amber-600 dark:text-amber-400",
    dot: "bg-amber-400",
  },
  {
    name: "yellow",
    bg: "bg-yellow-100 dark:bg-yellow-950/60",
    text: "text-yellow-600 dark:text-yellow-400",
    dot: "bg-yellow-400",
  },
  {
    name: "lime",
    bg: "bg-lime-100 dark:bg-lime-950/60",
    text: "text-lime-600 dark:text-lime-400",
    dot: "bg-lime-400",
  },
  {
    name: "green",
    bg: "bg-green-100 dark:bg-green-950/60",
    text: "text-green-600 dark:text-green-400",
    dot: "bg-green-400",
  },
  {
    name: "emerald",
    bg: "bg-emerald-100 dark:bg-emerald-950/60",
    text: "text-emerald-600 dark:text-emerald-400",
    dot: "bg-emerald-400",
  },
  {
    name: "cyan",
    bg: "bg-cyan-100 dark:bg-cyan-950/60",
    text: "text-cyan-600 dark:text-cyan-400",
    dot: "bg-cyan-400",
  },
  {
    name: "sky",
    bg: "bg-sky-100 dark:bg-sky-950/60",
    text: "text-sky-600 dark:text-sky-400",
    dot: "bg-sky-400",
  },
  {
    name: "blue",
    bg: "bg-blue-100 dark:bg-blue-950/60",
    text: "text-blue-600 dark:text-blue-400",
    dot: "bg-blue-400",
  },
  {
    name: "indigo",
    bg: "bg-indigo-100 dark:bg-indigo-950/60",
    text: "text-indigo-600 dark:text-indigo-400",
    dot: "bg-indigo-400",
  },
  {
    name: "violet",
    bg: "bg-violet-100 dark:bg-violet-950/60",
    text: "text-violet-600 dark:text-violet-400",
    dot: "bg-violet-400",
  },
  {
    name: "purple",
    bg: "bg-purple-100 dark:bg-purple-950/60",
    text: "text-purple-600 dark:text-purple-400",
    dot: "bg-purple-400",
  },
  {
    name: "fuchsia",
    bg: "bg-fuchsia-100 dark:bg-fuchsia-950/60",
    text: "text-fuchsia-600 dark:text-fuchsia-400",
    dot: "bg-fuchsia-400",
  },
  {
    name: "pink",
    bg: "bg-pink-100 dark:bg-pink-950/60",
    text: "text-pink-600 dark:text-pink-400",
    dot: "bg-pink-400",
  },
  {
    name: "rose",
    bg: "bg-rose-100 dark:bg-rose-950/60",
    text: "text-rose-600 dark:text-rose-400",
    dot: "bg-rose-400",
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
    const color = params?.get("color") ?? "blue";
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
  xs: { container: "w-6 h-6", icon: 14, text: "text-xs", radius: "rounded-md" },
  sm: { container: "w-8 h-8", icon: 16, text: "text-sm", radius: "rounded-lg" },
  "sm+": {
    container: "w-10 h-10",
    icon: 20,
    text: "text-base",
    radius: "rounded-xl",
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

export function AgentAvatar({
  icon,
  name,
  size = "md",
  className,
}: AgentAvatarProps) {
  const parsed = parseIconString(icon);
  const sizeConfig = SIZES[size];

  if (parsed.type === "icon") {
    const IconComp = getIconComponent(parsed.name);
    const color = getIconColor(parsed.color);

    return (
      <div
        className={cn(
          sizeConfig.container,
          sizeConfig.radius,
          color.bg,
          color.text,
          "flex items-center justify-center shrink-0 overflow-hidden",
          className,
        )}
        style={{
          boxShadow:
            "inset 0 0 0.5px 1px hsla(0, 0%, 100%, 0.075), 0 0 0 0.5px hsla(0, 0%, 0%, 0.12)",
        }}
      >
        {IconComp ? (
          <IconComp size={sizeConfig.icon} />
        ) : (
          (() => {
            const { IconComp: Fallback } = getDeterministicIcon(name);
            return <Fallback size={sizeConfig.icon} />;
          })()
        )}
      </div>
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
  const { IconComp: FallbackIcon, color: fallbackColor } =
    getDeterministicIcon(name);

  return (
    <div
      className={cn(
        sizeConfig.container,
        sizeConfig.radius,
        fallbackColor.bg,
        fallbackColor.text,
        "flex items-center justify-center shrink-0 overflow-hidden",
        className,
      )}
      style={{
        boxShadow:
          "inset 0 0 0.5px 1px hsla(0, 0%, 100%, 0.075), 0 0 0 0.5px hsla(0, 0%, 0%, 0.12)",
      }}
    >
      <FallbackIcon size={sizeConfig.icon} />
    </div>
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
    const { IconComp: FallbackIcon, color: fallbackColor } =
      getDeterministicIcon(name);

    return (
      <div
        className={cn(
          sizeConfig.container,
          sizeConfig.radius,
          fallbackColor.bg,
          fallbackColor.text,
          "flex items-center justify-center shrink-0 overflow-hidden",
          className,
        )}
        style={{
          boxShadow:
            "inset 0 0 0.5px 1px hsla(0, 0%, 100%, 0.075), 0 0 0 0.5px hsla(0, 0%, 0%, 0.12)",
        }}
      >
        <FallbackIcon size={sizeConfig.icon} />
      </div>
    );
  }

  return (
    <div
      className={cn(
        sizeConfig.container,
        sizeConfig.radius,
        bgClass,
        "shrink-0 overflow-hidden",
        className,
      )}
      style={{
        boxShadow:
          "inset 0 0 0.5px 1px hsla(0, 0%, 100%, 0.075), 0 0 0 0.5px hsla(0, 0%, 0%, 0.12)",
      }}
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
