import { useRef, useState, type RefObject } from "react";
import { LayoutAlt01, SearchMd } from "@untitledui/icons";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import type { SectionCatalogEntry } from "./section-catalog";
import { buildSectionPreviewUrl } from "./section-preview-url";

const GLOBAL_SECTION_ICON_COLOR = "oklch(0.7278 0.151 289)";

function useLazyPreviewVisible(scrollRootRef: RefObject<HTMLElement | null>) {
  const loadedRef = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const desiredNodeRef = useRef<HTMLDivElement | null>(null);
  const scrollRootRefMirror = useRef(scrollRootRef);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- mirror latest scroll root for stable observer callback
  scrollRootRefMirror.current = scrollRootRef;

  const [ref] = useState<(node: HTMLDivElement | null) => void>(() => {
    return (node: HTMLDivElement | null) => {
      desiredNodeRef.current = node;

      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }

      if (!node || loadedRef.current) return;

      queueMicrotask(() => {
        if (desiredNodeRef.current !== node || loadedRef.current) return;

        const observer = new IntersectionObserver(
          (entries) => {
            if (!entries[0]?.isIntersecting || loadedRef.current) return;
            loadedRef.current = true;
            setLoaded(true);
            observer.disconnect();
            observerRef.current = null;
          },
          {
            root: scrollRootRefMirror.current.current,
            rootMargin: "160px 0px",
          },
        );

        observer.observe(node);
        observerRef.current = observer;
      });
    };
  });

  return { ref, loaded };
}

function LazySectionPreview({
  previewUrl,
  title,
  scrollRootRef,
}: {
  previewUrl: string;
  title: string;
  scrollRootRef: RefObject<HTMLElement | null>;
}) {
  const { ref, loaded } = useLazyPreviewVisible(scrollRootRef);
  const [iframeLoaded, setIframeLoaded] = useState(false);

  return (
    <div
      ref={ref}
      className="relative aspect-[16/10] w-full overflow-hidden bg-muted/40"
    >
      {!loaded ? (
        <div className="flex h-full items-center justify-center">
          <LayoutAlt01 className="h-8 w-8 text-muted-foreground/30" />
        </div>
      ) : (
        <>
          {!iframeLoaded && (
            <div className="absolute inset-0 flex items-center justify-center bg-muted/40">
              <LayoutAlt01 className="h-8 w-8 animate-pulse text-muted-foreground/40" />
            </div>
          )}
          <iframe
            src={previewUrl}
            title={`Preview ${title}`}
            className="pointer-events-none h-[200%] w-[200%] origin-top-left scale-50 border-0 bg-white"
            tabIndex={-1}
            onLoad={() => setIframeLoaded(true)}
          />
        </>
      )}
    </div>
  );
}

function SectionGalleryCard({
  entry,
  previewUrl,
  scrollRootRef,
  onSelect,
}: {
  entry: SectionCatalogEntry;
  previewUrl: string;
  scrollRootRef: RefObject<HTMLElement | null>;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group flex flex-col overflow-hidden rounded-lg border bg-card text-left transition-colors",
        "hover:border-primary/40 hover:bg-accent/30",
        entry.isSavedBlock &&
          "border-[oklch(0.7278_0.151_289/0.35)] hover:bg-[oklch(0.7278_0.151_289/0.08)]",
      )}
    >
      <LazySectionPreview
        previewUrl={previewUrl}
        title={entry.title}
        scrollRootRef={scrollRootRef}
      />
      <div className="flex items-center gap-2 border-t px-3 py-2.5">
        <LayoutAlt01
          className="h-4 w-4 shrink-0"
          style={
            entry.isSavedBlock
              ? { color: GLOBAL_SECTION_ICON_COLOR }
              : undefined
          }
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{entry.title}</p>
          {entry.description && (
            <p className="truncate text-xs text-muted-foreground">
              {entry.description}
            </p>
          )}
        </div>
      </div>
    </button>
  );
}

export function AddSectionModal({
  open,
  onOpenChange,
  sections,
  previewBaseUrl,
  livePageResolveType,
  siteTheme,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sections: SectionCatalogEntry[];
  previewBaseUrl: string;
  livePageResolveType: string;
  siteTheme?: Record<string, unknown>;
  onSelect: (entry: SectionCatalogEntry) => void;
}) {
  const [search, setSearch] = useState("");
  const [prevOpen, setPrevOpen] = useState(open);
  const scrollRef = useRef<HTMLDivElement>(null);

  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setSearch("");
  }

  const query = search.trim().toLowerCase();
  const filtered = query
    ? sections.filter(
        (entry) =>
          entry.title.toLowerCase().includes(query) ||
          entry.resolveType.toLowerCase().includes(query) ||
          entry.description?.toLowerCase().includes(query),
      )
    : sections;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeButtonClassName="top-3 right-3"
        className="flex h-[90vh] max-h-[90vh] w-[96vw] max-w-[96vw] sm:max-w-[96vw] flex-col gap-0 overflow-hidden p-0"
      >
        <DialogHeader className="shrink-0 border-b px-4 py-3 text-left">
          <DialogTitle>Add section</DialogTitle>
          <div className="relative pt-2">
            <SearchMd
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search sections..."
              className="h-9 pl-8"
            />
          </div>
        </DialogHeader>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="p-4">
            {filtered.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No sections found.
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {filtered.map((entry) => (
                  <SectionGalleryCard
                    key={entry.resolveType}
                    entry={entry}
                    scrollRootRef={scrollRef}
                    previewUrl={buildSectionPreviewUrl(
                      previewBaseUrl,
                      livePageResolveType,
                      entry.previewBlock,
                      siteTheme,
                    )}
                    onSelect={() => onSelect(entry)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
