import type * as React from "react";

import { cn } from "../lib/utils.ts";
import { Card } from "./card.tsx";

/** One thing you open from a grid: a project, a connection, an app. */
function EntityCardRoot({
  className,
  ...props
}: Omit<React.ComponentProps<typeof Card>, "size" | "interactive">) {
  return (
    <Card
      data-slot="entity-card"
      size="tile"
      interactive={Boolean(props.onClick) || props.asChild}
      className={cn("min-w-0", className)}
      {...props}
    />
  );
}

/** Its icon or avatar, with an optional status or menu on the right. */
function EntityCardHeader({
  icon,
  trailing,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  icon: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <div
      data-slot="entity-card-header"
      className={cn("flex items-start justify-between gap-3", className)}
      {...props}
    >
      {icon}
      {trailing}
    </div>
  );
}

function EntityCardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="entity-card-title"
      className={cn("truncate text-sm font-medium", className)}
      {...props}
    />
  );
}

function EntityCardDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="entity-card-description"
      className={cn("text-meta -mt-2 line-clamp-2", className)}
      {...props}
    />
  );
}

/** Counts, people, a last update; set off by a hairline. */
function EntityCardFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="entity-card-footer"
      className={cn(
        "border-border text-meta flex items-center justify-between gap-2 border-t pt-3",
        className,
      )}
      {...props}
    />
  );
}

function EntityCardSkeleton() {
  return (
    <Card size="tile" aria-hidden>
      <div className="bg-muted size-8 animate-pulse rounded-lg" />
      <div className="flex flex-col gap-1.5">
        <div className="bg-muted h-4 w-32 animate-pulse rounded-full" />
        <div className="bg-muted h-3 w-44 animate-pulse rounded-full" />
      </div>
      <div className="border-border flex justify-between border-t pt-3">
        <div className="bg-muted h-3 w-16 animate-pulse rounded-full" />
      </div>
    </Card>
  );
}

export const EntityCard = Object.assign(EntityCardRoot, {
  Header: EntityCardHeader,
  Title: EntityCardTitle,
  Description: EntityCardDescription,
  Footer: EntityCardFooter,
  Skeleton: EntityCardSkeleton,
});
