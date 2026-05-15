import { cn } from "@deco/ui/lib/utils.js";

interface PageEntry {
  key: string;
  name: string;
  path: string;
}

function parsePageName(key: string): string {
  // "pages-home-c4bcbfb771e9" -> "home"
  // "pages-Category%20Page-69217" -> "Category Page"
  let name = key;
  if (name.startsWith("pages-")) name = name.slice(6);
  // Remove trailing hash suffix (last segment after last -)
  const lastDash = name.lastIndexOf("-");
  if (lastDash > 0) {
    const suffix = name.slice(lastDash + 1);
    // Only strip if suffix looks like a hash (hex or short number)
    if (/^[a-f0-9]+$/i.test(suffix) && suffix.length >= 4) {
      name = name.slice(0, lastDash);
    }
  }
  return decodeURIComponent(name);
}

export function extractPages(decofile: Record<string, unknown>): PageEntry[] {
  const pages: PageEntry[] = [];
  for (const [key, val] of Object.entries(decofile)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const obj = val as Record<string, unknown>;
      if (typeof obj.path === "string" && Array.isArray(obj.sections)) {
        pages.push({
          key,
          name: parsePageName(key),
          path: obj.path,
        });
      }
    }
  }
  return pages;
}

export function PageList({
  pages,
  selectedKey,
  onSelect,
}: {
  pages: PageEntry[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  if (pages.length === 0) {
    return (
      <p className="text-xs text-muted-foreground px-2 py-3">No pages found.</p>
    );
  }

  return (
    <div className="space-y-0.5">
      {pages.map((page) => (
        <button
          key={page.key}
          type="button"
          onClick={() => onSelect(page.key)}
          className={cn(
            "w-full text-left px-2 py-1.5 rounded-md text-sm transition-colors",
            selectedKey === page.key
              ? "bg-accent text-accent-foreground"
              : "hover:bg-muted",
          )}
        >
          <div className="font-medium truncate">{page.name}</div>
          <div className="text-xs text-muted-foreground truncate">
            {page.path}
          </div>
        </button>
      ))}
    </div>
  );
}
