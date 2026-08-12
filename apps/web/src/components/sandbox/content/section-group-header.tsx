import { cn } from "@decocms/ui/lib/utils.ts";
import type { GlobalSectionEntry } from "@/components/sections-editor/page-list";

export interface SavedSectionGroup {
  label: string;
  sections: GlobalSectionEntry[];
}

/** Short label for a section's underlying component resolveType. */
function sectionTypeLabel(resolveType: string): string {
  return (
    resolveType
      .split("/")
      .pop()
      ?.replace(/\.tsx?$/, "") ||
    resolveType ||
    "Section"
  );
}

/** Group saved sections by their underlying `resolveType`, sorted by label. */
export function groupSavedSectionsByResolveType(
  sections: GlobalSectionEntry[],
): SavedSectionGroup[] {
  const byLabel = new Map<string, GlobalSectionEntry[]>();
  for (const section of sections) {
    const label = sectionTypeLabel(section.resolveType);
    const bucket = byLabel.get(label);
    if (bucket) bucket.push(section);
    else byLabel.set(label, [section]);
  }
  return [...byLabel.entries()]
    .map(([label, groupSections]) => ({ label, sections: groupSections }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function GroupHeader({
  icon: Icon,
  label,
  className,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 px-2.5 pb-1 pt-1 text-xs font-medium text-muted-foreground/70",
        className,
      )}
    >
      <Icon size={13} className="shrink-0" />
      {label}
    </div>
  );
}
