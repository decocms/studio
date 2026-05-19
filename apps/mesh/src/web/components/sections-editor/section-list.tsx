import { cn } from "@deco/ui/lib/utils.js";
import { DotsGrid, Eye, EyeOff, LayoutAlt01, Zap } from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

// ─── types ─────────────────────────────────────────────────────────────────────

export interface ParsedSection {
  index: number;
  resolveType: string;
  label: string;
  isLazy?: boolean;
  isHidden?: boolean;
  isSavedBlock?: boolean;
  isMultivariate?: boolean;
}

interface RawSection {
  __resolveType: string;
  section?: { __resolveType?: string };
  variants?: Array<{
    value?: Record<string, unknown>;
    rule?: Record<string, unknown>;
  }>;
  [key: string]: unknown;
}

// ─── parsing helpers ───────────────────────────────────────────────────────────

export const LAZY_SUFFIXES = [
  "website/sections/Rendering/Lazy.tsx",
  "website/sections/Rendering/SingleDeferred.tsx",
];

export function isLazyResolveType(rt: string): boolean {
  return LAZY_SUFFIXES.some((suffix) => rt.endsWith(suffix));
}

function labelFromResolveType(rt: string): string {
  const parts = rt.split("/");
  const filename = parts[parts.length - 1] ?? rt;
  return filename.replace(/\.(tsx|ts|jsx|js)$/, "") || rt;
}

/**
 * Parse raw decofile sections into display-ready entries with
 * isLazy / isHidden / isSavedBlock / isMultivariate flags.
 * Mirrors admin-mcp's `parseSectionsFromArray()`.
 */
export function parseSections(
  rawSections: RawSection[],
  decofile: Record<string, unknown>,
): ParsedSection[] {
  return rawSections.map((s, idx) => {
    const rt = s.__resolveType ?? "";
    const isLazy = isLazyResolveType(rt);

    // ── Saved block (named block ref — no "/" in resolveType) ────────
    if (!isLazy && rt !== "" && !rt.includes("/") && rt in decofile) {
      const resolvedBlock = decofile[rt] as Record<string, unknown> | undefined;
      const label =
        (typeof resolvedBlock?.name === "string" && resolvedBlock.name) ||
        rt.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) ||
        `Section ${idx + 1}`;
      return {
        index: idx,
        resolveType: rt,
        label,
        isLazy: false,
        isSavedBlock: true,
      };
    }

    // ── Multivariate detection ──────────────────────────────────────
    const innerSection = isLazy
      ? (s.section as RawSection | undefined)
      : undefined;
    const mvRt = isLazy ? (innerSection?.__resolveType ?? "") : rt;

    if (mvRt.includes("flags/multivariate")) {
      const mvObj = (isLazy ? innerSection : s) as RawSection;
      const rawVariants = Array.isArray(mvObj?.variants) ? mvObj.variants : [];

      // ── Hidden: single variant with "never" matcher ───────────────
      const NEVER_TYPES = ["website/matchers/never.ts"];
      if (
        rawVariants.length === 1 &&
        NEVER_TYPES.includes(
          (rawVariants[0]?.rule?.__resolveType as string) ?? "",
        )
      ) {
        const innerValue = (rawVariants[0]?.value ?? {}) as Record<
          string,
          unknown
        >;
        let innerRt = (innerValue.__resolveType as string) ?? "";
        const innerIsLazy = isLazyResolveType(innerRt);
        if (innerIsLazy) {
          const nested = innerValue.section as
            | Record<string, unknown>
            | undefined;
          innerRt = (nested?.__resolveType as string) ?? innerRt;
        }
        return {
          index: idx,
          resolveType: rt,
          label: labelFromResolveType(innerRt) || `Section ${idx + 1}`,
          isHidden: true,
          isLazy: innerIsLazy,
        };
      }

      // Regular multivariate
      const firstValueRt = (
        rawVariants[0]?.value as Record<string, unknown> | undefined
      )?.__resolveType as string | undefined;
      const sectionLabel = firstValueRt
        ? labelFromResolveType(firstValueRt)
        : "Section";
      return {
        index: idx,
        resolveType: rt,
        label: `Variants of ${sectionLabel}`,
        isMultivariate: true,
        isLazy,
      };
    }

    // ── Lazy-wrapped saved block (e.g. Lazy → Header) ──────────────
    const effectiveRt = isLazy ? (s.section?.__resolveType ?? rt) : rt;
    if (
      isLazy &&
      effectiveRt !== "" &&
      !effectiveRt.includes("/") &&
      effectiveRt in decofile
    ) {
      const resolvedBlock = decofile[effectiveRt] as
        | Record<string, unknown>
        | undefined;
      const label =
        (typeof resolvedBlock?.name === "string" && resolvedBlock.name) ||
        effectiveRt
          .replace(/[-_]/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase()) ||
        `Section ${idx + 1}`;
      return {
        index: idx,
        resolveType: rt,
        label,
        isLazy: true,
        isSavedBlock: true,
      };
    }

    // ── Normal section (possibly lazy-wrapped) ──────────────────────
    return {
      index: idx,
      resolveType: rt,
      label: labelFromResolveType(effectiveRt) || `Section ${idx + 1}`,
      isLazy,
    };
  });
}

// ─── sortable item ──────────────────────────────────────────────────────────────

function SortableSectionItem({
  section,
  selected,
  onSelect,
}: {
  section: ParsedSection;
  selected: boolean;
  onSelect: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: String(section.index) });

  const style = {
    transform: CSS.Transform.toString(
      transform ? { ...transform, x: 0 } : null,
    ),
    transition,
    opacity: isDragging ? 0.5 : undefined,
    zIndex: isDragging ? 100 : undefined,
  };

  const saved = section.isSavedBlock === true;
  const multivariate = section.isMultivariate === true;

  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={onSelect}
      className={cn(
        "group flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-2.5 transition-colors active:cursor-grabbing",
        selected
          ? "bg-accent text-accent-foreground"
          : saved
            ? "text-[oklch(0.45_0.15_289)] hover:bg-[oklch(0.7278_0.151_289/0.12)] dark:text-[oklch(0.78_0.15_289)] dark:hover:bg-[oklch(0.7278_0.151_289/0.15)]"
            : multivariate
              ? "text-[oklch(0.45_0.15_160)] hover:bg-[oklch(0.65_0.15_160/0.12)] dark:text-[oklch(0.78_0.15_160)] dark:hover:bg-[oklch(0.65_0.15_160/0.15)]"
              : "text-foreground/80 hover:bg-accent hover:text-accent-foreground",
      )}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        listeners?.onKeyDown?.(e);
        if (e.key === "Enter" || e.key === " ") onSelect();
      }}
    >
      <DotsGrid className="h-4 w-4 shrink-0 text-muted-foreground/40" />

      <LayoutAlt01
        className="h-4 w-4 shrink-0"
        style={
          saved
            ? { color: "oklch(0.7278 0.151 289)" }
            : multivariate
              ? { color: "oklch(0.65 0.15 160)" }
              : undefined
        }
      />
      <span
        className={cn(
          "flex-1 truncate text-sm font-medium",
          section.isHidden && "line-through opacity-50",
        )}
      >
        {section.label}
      </span>

      {/* Hidden toggle */}
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "shrink-0 rounded p-1 transition-colors",
              section.isHidden
                ? "text-muted-foreground"
                : "text-muted-foreground/60 opacity-0 group-hover:opacity-100",
            )}
          >
            {section.isHidden ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">
          {section.isHidden ? "Hidden section" : "Visible"}
        </TooltipContent>
      </Tooltip>

      {/* Lazy indicator */}
      {section.isLazy && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="shrink-0 rounded p-1 text-yellow-500">
              <Zap className="h-3.5 w-3.5" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">Lazy loaded</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

// ─── component ─────────────────────────────────────────────────────────────────

export function SectionList({
  sections,
  selectedIndex,
  onSelect,
  onReorder,
}: {
  sections: ParsedSection[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const sortableIds = sections.map((s) => String(s.index));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = sortableIds.indexOf(String(active.id));
    const newIndex = sortableIds.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;

    onReorder?.(oldIndex, newIndex);
  };

  if (sections.length === 0) {
    return (
      <p className="text-xs text-muted-foreground px-2 py-3">
        No sections in this page.
      </p>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={sortableIds}
        strategy={verticalListSortingStrategy}
      >
        <div className="space-y-1">
          {sections.map((section) => (
            <SortableSectionItem
              key={`${section.resolveType}-${section.index}`}
              section={section}
              selected={selectedIndex === section.index}
              onSelect={() => onSelect(section.index)}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
