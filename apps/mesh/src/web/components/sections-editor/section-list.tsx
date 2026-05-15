import { cn } from "@deco/ui/lib/utils.js";

interface SectionEntry {
  __resolveType: string;
  [key: string]: unknown;
}

function sectionLabel(resolveType: string): string {
  // "site/sections/Images/Carousel.tsx" -> "Carousel"
  // "website/sections/Rendering/Lazy.tsx" -> "Lazy"
  // Named blocks (no "/") stay as-is: "Header" -> "Header"
  if (!resolveType.includes("/")) return resolveType;
  const filename = resolveType.split("/").pop() ?? resolveType;
  return filename.replace(/\.tsx?$/, "");
}

export function SectionList({
  sections,
  selectedIndex,
  onSelect,
}: {
  sections: SectionEntry[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
}) {
  if (sections.length === 0) {
    return (
      <p className="text-xs text-muted-foreground px-2 py-3">
        No sections in this page.
      </p>
    );
  }

  return (
    <div className="space-y-0.5">
      {sections.map((section, i) => {
        const rt = section.__resolveType ?? "Unknown";
        const isNamedBlock = !rt.includes("/");

        return (
          <button
            key={`${rt}-${i}`}
            type="button"
            onClick={() => onSelect(i)}
            className={cn(
              "w-full text-left px-2 py-1.5 rounded-md text-sm transition-colors",
              selectedIndex === i
                ? "bg-accent text-accent-foreground"
                : "hover:bg-muted",
            )}
          >
            <div className="font-medium truncate">{sectionLabel(rt)}</div>
            {isNamedBlock && (
              <div className="text-xs text-muted-foreground truncate">
                block ref
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
