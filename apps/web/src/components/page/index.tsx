import { cn } from "@decocms/ui/lib/utils.ts";
import type {
  ComponentPropsWithoutRef,
  PropsWithChildren,
  ReactNode,
} from "react";

/** Route content. Panel owns the surrounding surface and persistent controls. */
function PageRoot({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      {...props}
      data-slot="page"
      className={cn(
        "flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden",
        className,
      )}
    />
  );
}

/** The scroll owner for document pages. Editors use Panel.Content's canvas instead. */
function PageContent({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      {...props}
      data-slot="page-content"
      className={cn("min-h-0 min-w-0 flex-1 overflow-auto", className)}
    />
  );
}

const CONTAINER_WIDTH = {
  reading: "max-w-[720px]",
  standard: "max-w-5xl",
  wide: "max-w-[1200px]",
  fluid: "max-w-none",
} as const;

function PageContainer({
  className,
  width = "wide",
  ...props
}: ComponentPropsWithoutRef<"div"> & { width?: keyof typeof CONTAINER_WIDTH }) {
  return (
    <div
      {...props}
      data-slot="page-container"
      data-width={width}
      className={cn(
        "mx-auto w-full px-4 pt-8 pb-6 md:px-10 md:pt-12 md:pb-10",
        CONTAINER_WIDTH[width],
        className,
      )}
    />
  );
}

function PageTitle({
  children,
  actions,
  className,
}: PropsWithChildren<{ actions?: ReactNode; className?: string }>) {
  return (
    <div
      data-slot="page-title"
      className={cn(
        "flex flex-wrap items-center justify-between gap-3",
        className,
      )}
    >
      <h1 className="min-w-0 text-xl font-medium">{children}</h1>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export const Page = Object.assign(PageRoot, {
  Content: PageContent,
  Container: PageContainer,
  Title: PageTitle,
});
