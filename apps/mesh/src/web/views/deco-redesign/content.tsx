/**
 * Content (mock)
 *
 * Mirrors the real deco-sites Content browser (sandbox/content/content-browser):
 * a Collections rail (Pages / Sections) → a searchable item list → a detail
 * pane showing the selected page's sections (pages → sections, like the
 * SectionsEditor). The real one reads the live decofile from a running agent
 * sandbox; this is a standalone mock with the same shape. Mock only.
 */

import { useState } from "react";
import {
  ChevronRight,
  LayersTwo01,
  LayoutAlt01,
  Plus,
  SearchSm,
} from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";

interface Section {
  name: string;
  resolveType: string;
}

interface PageEntry {
  key: string;
  name: string;
  path: string;
  sections: Section[];
}

interface GlobalSection {
  key: string;
  name: string;
  resolveType: string;
  appliesTo: string;
}

const PAGES: PageEntry[] = [
  {
    key: "home",
    name: "Home",
    path: "/",
    sections: [
      { name: "Hero", resolveType: "site/sections/Hero.tsx" },
      {
        name: "Featured collection",
        resolveType: "site/sections/ProductShelf.tsx",
      },
      { name: "Editorial", resolveType: "site/sections/Editorial.tsx" },
      { name: "Newsletter", resolveType: "site/sections/Newsletter.tsx" },
    ],
  },
  {
    key: "new-in",
    name: "New in",
    path: "/new-in",
    sections: [
      { name: "Breadcrumb", resolveType: "site/sections/Breadcrumb.tsx" },
      { name: "Product list", resolveType: "site/sections/PLP.tsx" },
    ],
  },
  {
    key: "dresses",
    name: "Dresses",
    path: "/dresses",
    sections: [
      { name: "Breadcrumb", resolveType: "site/sections/Breadcrumb.tsx" },
      { name: "Product list", resolveType: "site/sections/PLP.tsx" },
      { name: "Editorial", resolveType: "site/sections/Editorial.tsx" },
    ],
  },
  {
    key: "sale",
    name: "Sale",
    path: "/sale",
    sections: [
      { name: "Promo banner", resolveType: "site/sections/PromoBanner.tsx" },
      { name: "Product list", resolveType: "site/sections/PLP.tsx" },
    ],
  },
  {
    key: "about",
    name: "About",
    path: "/about",
    sections: [
      { name: "Rich text", resolveType: "site/sections/RichText.tsx" },
    ],
  },
];

const GLOBAL_SECTIONS: GlobalSection[] = [
  {
    key: "announcement",
    name: "Announcement bar",
    resolveType: "site/sections/AnnouncementBar.tsx",
    appliesTo: "All pages",
  },
  {
    key: "header",
    name: "Header",
    resolveType: "site/sections/Header.tsx",
    appliesTo: "All pages",
  },
  {
    key: "footer",
    name: "Footer",
    resolveType: "site/sections/Footer.tsx",
    appliesTo: "All pages",
  },
];

type CollectionId = "pages" | "sections";

const COLLECTIONS: {
  id: CollectionId;
  label: string;
  icon: React.ReactNode;
}[] = [
  { id: "pages", label: "Pages", icon: <LayoutAlt01 size={16} /> },
  { id: "sections", label: "Sections", icon: <LayersTwo01 size={16} /> },
];

export function ContentView() {
  const [collection, setCollection] = useState<CollectionId>("pages");
  const [selected, setSelected] = useState<string>("home");
  const [query, setQuery] = useState("");

  const counts: Record<CollectionId, number> = {
    pages: PAGES.length,
    sections: GLOBAL_SECTIONS.length,
  };

  const q = query.toLowerCase();
  const pages = q
    ? PAGES.filter(
        (p) =>
          p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
      )
    : PAGES;
  const sections = q
    ? GLOBAL_SECTIONS.filter((s) => s.name.toLowerCase().includes(q))
    : GLOBAL_SECTIONS;

  const selectedPage = PAGES.find((p) => p.key === selected);
  const selectedSection = GLOBAL_SECTIONS.find((s) => s.key === selected);

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* Collections rail */}
      <aside className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-border p-2">
        {COLLECTIONS.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => {
              setCollection(c.id);
              setQuery("");
              setSelected(c.id === "pages" ? "home" : "announcement");
            }}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
              collection === c.id
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
          >
            <span className="shrink-0">{c.icon}</span>
            <span className="flex-1 truncate">{c.label}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {counts[c.id]}
            </span>
          </button>
        ))}
      </aside>

      {/* Item list */}
      <div className="flex w-72 shrink-0 flex-col border-r border-border">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <SearchSm size={14} className="shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${collection}...`}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
          />
          <button
            type="button"
            aria-label="New"
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5">
          {collection === "pages"
            ? pages.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setSelected(p.key)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
                    selected === p.key ? "bg-muted" : "hover:bg-muted/50",
                  )}
                >
                  <LayoutAlt01
                    size={15}
                    className="shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {p.name}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {p.path}
                  </span>
                </button>
              ))
            : sections.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setSelected(s.key)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
                    selected === s.key ? "bg-muted" : "hover:bg-muted/50",
                  )}
                >
                  <LayersTwo01
                    size={15}
                    className="shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {s.name}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {s.appliesTo}
                  </span>
                </button>
              ))}
        </div>
      </div>

      {/* Detail */}
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        {collection === "pages" && selectedPage ? (
          <>
            <div className="flex items-center gap-3 border-b border-border px-5 py-3">
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-sm font-medium text-foreground">
                  {selectedPage.name}
                </h2>
                <code className="font-mono text-xs text-muted-foreground">
                  {selectedPage.path}
                </code>
              </div>
              <button
                type="button"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
              >
                <Plus size={14} />
                Add section
              </button>
            </div>
            <div className="flex flex-col gap-1.5 p-4">
              {selectedPage.sections.map((sec, i) => (
                <div
                  key={`${sec.resolveType}-${i}`}
                  className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3"
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground">
                    <LayoutAlt01 size={14} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {sec.name}
                    </span>
                    <code className="block truncate font-mono text-xs text-muted-foreground">
                      {sec.resolveType}
                    </code>
                  </span>
                  <ChevronRight
                    size={16}
                    className="shrink-0 text-muted-foreground/50"
                  />
                </div>
              ))}
            </div>
          </>
        ) : selectedSection ? (
          <>
            <div className="border-b border-border px-5 py-3">
              <h2 className="text-sm font-medium text-foreground">
                {selectedSection.name}
              </h2>
              <code className="font-mono text-xs text-muted-foreground">
                {selectedSection.resolveType}
              </code>
            </div>
            <div className="p-4">
              <div className="rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
                Global section · {selectedSection.appliesTo}. Editing it updates
                every page that uses it.
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Select an item to edit.
          </div>
        )}
      </div>
    </div>
  );
}
