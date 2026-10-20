import { cn } from "../lib/utils.ts";
import type { ReactNode } from "react";

interface ColumnConfig {
  sm?: number;
  md?: number;
  lg?: number;
  xl?: number;
  "2xl"?: number;
}

interface EntityGridProps {
  children: ReactNode;
  columns?: ColumnConfig;
  gap?: number;
  className?: string;
}

// Object maps for compile-time Tailwind class generation
const gapClasses: Record<number, string> = {
  0: "gap-0",
  1: "gap-1",
  2: "gap-2",
  3: "gap-3",
  4: "gap-4",
  5: "gap-5",
  6: "gap-6",
  8: "gap-8",
};

const gridColsClasses: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-4",
  5: "grid-cols-5",
  6: "grid-cols-6",
  7: "grid-cols-7",
  8: "grid-cols-8",
};

const gridColsMdClasses: Record<number, string> = {
  1: "@min-3xl:grid-cols-1",
  2: "@min-3xl:grid-cols-2",
  3: "@min-3xl:grid-cols-3",
  4: "@min-3xl:grid-cols-4",
  5: "@min-3xl:grid-cols-5",
  6: "@min-3xl:grid-cols-6",
  7: "@min-3xl:grid-cols-7",
  8: "@min-3xl:grid-cols-8",
};

const gridColsLgClasses: Record<number, string> = {
  1: "@min-6xl:grid-cols-1",
  2: "@min-6xl:grid-cols-2",
  3: "@min-6xl:grid-cols-3",
  4: "@min-6xl:grid-cols-4",
  5: "@min-6xl:grid-cols-5",
  6: "@min-6xl:grid-cols-6",
  7: "@min-6xl:grid-cols-7",
  8: "@min-6xl:grid-cols-8",
};

const gridColsXlClasses: Record<number, string> = {
  1: "@min-7xl:grid-cols-1",
  2: "@min-7xl:grid-cols-2",
  3: "@min-7xl:grid-cols-3",
  4: "@min-7xl:grid-cols-4",
  5: "@min-7xl:grid-cols-5",
  6: "@min-7xl:grid-cols-6",
  7: "@min-7xl:grid-cols-7",
  8: "@min-7xl:grid-cols-8",
};

const gridCols2xlClasses: Record<number, string> = {
  1: "@min-8xl:grid-cols-1",
  2: "@min-8xl:grid-cols-2",
  3: "@min-8xl:grid-cols-3",
  4: "@min-8xl:grid-cols-4",
  5: "@min-8xl:grid-cols-5",
  6: "@min-8xl:grid-cols-6",
  7: "@min-8xl:grid-cols-7",
  8: "@min-8xl:grid-cols-8",
};

/** Stable identity: an inline default would be a new object every render. */
const DEFAULT_COLUMNS: ColumnConfig = { sm: 2, md: 3, lg: 4 };

function EntityGridRoot({
  children,
  columns = DEFAULT_COLUMNS,
  gap = 4,
  className,
}: EntityGridProps) {
  const gridClasses = cn(
    "w-full grid",
    gapClasses[gap],
    columns.sm && gridColsClasses[columns.sm],
    columns.md && gridColsMdClasses[columns.md],
    columns.lg && gridColsLgClasses[columns.lg],
    columns.xl && gridColsXlClasses[columns.xl],
    columns["2xl"] && gridCols2xlClasses[columns["2xl"]],
    className,
  );

  return <div className={gridClasses}>{children}</div>;
}

function EntityGridSkeleton({
  count = 8,
  columns = DEFAULT_COLUMNS,
  gap = 4,
  className,
}: Omit<EntityGridProps, "children"> & { count?: number }) {
  return (
    <EntityGridRoot columns={columns} gap={gap} className={className}>
      {Array.from({ length: count }).map((_, index) => (
        <div
          key={index}
          className="bg-card hover:bg-accent transition-colors flex flex-col rounded-lg animate-pulse"
        >
          <div className="p-4 flex flex-col gap-4">
            <div className="h-12 w-12 bg-muted rounded-lg" />
            <div className="h-4 w-32 bg-muted rounded-lg" />
            <div className="h-4 w-32 bg-muted rounded-lg" />
          </div>
          <div className="p-4 border-t border-border flex items-center">
            <div className="h-6 w-6 bg-muted rounded-full animate-pulse" />
            <div className="h-6 w-6 bg-muted rounded-full animate-pulse -ml-2" />
            <div className="h-6 w-6 bg-muted rounded-full animate-pulse -ml-2" />
          </div>
        </div>
      ))}
    </EntityGridRoot>
  );
}

export const EntityGrid = Object.assign(EntityGridRoot, {
  Skeleton: EntityGridSkeleton,
});
