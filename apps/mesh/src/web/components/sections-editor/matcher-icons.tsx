import { FilterLines } from "@untitledui/icons";
import type { ComponentType, SVGProps } from "react";
import { getIconComponent } from "../agent-icon";

type IconComponent = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

const KNOWN_MATCHER_ICON_BY_RESOLVE_TYPE: Array<[RegExp, string]> = [
  [/always|matchalways/i, "Users03"],
  [/device|matchdevice/i, "Phone02"],
  [/date|matchdate/i, "Calendar"],
  [/random|matchrandom/i, "Shuffle01"],
  [/host|matchhost/i, "Globe02"],
  [/location|matchlocation/i, "MarkerPin01"],
  [/pathname/i, "Link03"],
  [/cron|matchcron/i, "Clock"],
  [/multi|matchmulti/i, "FilterLines"],
  [/never|matchnever/i, "EyeOff"],
  [/environment|matchenvironment/i, "Cloud01"],
  [/eq\.ts|\/eq$/i, "Brackets"],
  [/user|requser|isdecouser/i, "User01"],
  [/site|template/i, "LayoutAlt01"],
];

/** Admin schema icon ids → @untitledui/icons component names. */
const SCHEMA_ICON_TO_UNTITLED: Record<string, string> = {
  "device-mobile": "Phone02",
  "device-desktop": "Monitor01",
  "device-tablet": "Tablet01",
  "calendar-event": "Calendar",
  "calendar-month": "Calendar",
  clock: "Clock",
  "current-location": "MarkerPin01",
  "map-2": "MarkerPin01",
  "world-search": "Globe02",
  shuffle: "Shuffle01",
  filter: "FilterLines",
  "eye-off": "EyeOff",
  flask: "Beaker02",
  link: "Link03",
  "git-merge": "GitBranch01",
  users: "Users03",
  flag: "Flag01",
  "cloud-storm": "Cloud01",
  campaign: "Announcement01",
  experiment: "Beaker02",
  language: "Globe02",
  "hand-click": "CursorClick01",
};

function isUntitledIconName(name: string): boolean {
  return getIconComponent(name) !== undefined;
}

export function resolveMatcherIconName(
  resolveType: string,
  schemaIcon?: string,
): string {
  if (schemaIcon) {
    if (isUntitledIconName(schemaIcon)) return schemaIcon;

    const mapped = SCHEMA_ICON_TO_UNTITLED[schemaIcon];
    if (mapped && isUntitledIconName(mapped)) return mapped;
  }

  for (const [pattern, iconName] of KNOWN_MATCHER_ICON_BY_RESOLVE_TYPE) {
    if (pattern.test(resolveType) && isUntitledIconName(iconName)) {
      return iconName;
    }
  }

  return "FilterLines";
}

function getMatcherIconComponent(iconName: string): IconComponent {
  return getIconComponent(iconName) ?? FilterLines;
}

export function MatcherIcon({
  iconName,
  size = "md",
  className,
}: {
  iconName: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const Icon = getMatcherIconComponent(iconName);
  const boxClass = size === "sm" ? "size-7" : "size-9";
  const iconSize = size === "sm" ? 16 : 18;

  return (
    <div
      className={`flex ${boxClass} shrink-0 items-center justify-center rounded-full bg-muted ${className ?? ""}`}
    >
      <Icon size={iconSize} className="text-muted-foreground" />
    </div>
  );
}
