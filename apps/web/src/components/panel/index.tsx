import {
  createContext,
  use,
  useState,
  type ComponentPropsWithoutRef,
  type Dispatch,
  type ReactNode,
  type RefCallback,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@decocms/ui/lib/utils.ts";

type Region = "left" | "center" | "right";
type Targets = Record<Region, HTMLDivElement | null>;

const TopbarContext = createContext<{
  targets: Targets;
  setTargets: Dispatch<SetStateAction<Targets>>;
} | null>(null);

/** A visual surface. The workspace owns its placement; the route owns its contents. */
function PanelRoot({
  children,
  className,
  variant = "card",
  ...props
}: ComponentPropsWithoutRef<"div"> & { variant?: "card" | "plain" }) {
  const [targets, setTargets] = useState<Targets>({
    left: null,
    center: null,
    right: null,
  });

  return (
    <TopbarContext value={{ targets, setTargets }}>
      <div
        {...props}
        data-slot="panel"
        className={cn(
          "flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background",
          variant === "card" &&
            "rounded-xl card-shadow [transform:translateZ(0)]",
          className,
        )}
      >
        {children}
      </div>
    </TopbarContext>
  );
}

function PanelTopbar({
  className,
  ...props
}: ComponentPropsWithoutRef<"header">) {
  return (
    <header
      {...props}
      data-slot="panel-topbar"
      className={cn(
        "@container/panel-header relative z-10 flex h-12 shrink-0 items-center justify-between gap-2 px-1.5",
        className,
      )}
    />
  );
}

function createTopbarRegion(region: Region, regionClassName: string) {
  function TopbarRegion({
    className,
    ...props
  }: ComponentPropsWithoutRef<"div">) {
    return (
      <div
        {...props}
        data-slot={`panel-topbar-${region}`}
        className={cn(
          "flex min-w-0 items-center gap-1",
          regionClassName,
          className,
        )}
      />
    );
  }

  function Target({
    className,
    ...props
  }: Omit<ComponentPropsWithoutRef<"div">, "children">) {
    const context = use(TopbarContext);
    if (!context) throw new Error("Panel topbar targets require a Panel");
    const { setTargets } = context;
    // Ref cleanup may run after a replacement attaches during a route transition.
    const [targetRef] = useState<RefCallback<HTMLDivElement>>(
      () => (node: HTMLDivElement | null) => {
        if (!node) return;
        setTargets((current) => {
          if (current[region] && current[region] !== node) {
            throw new Error(`Panel topbar has two targets for ${region}`);
          }
          return current[region] === node
            ? current
            : { ...current, [region]: node };
        });
        return () => {
          setTargets((current) =>
            current[region] === node ? { ...current, [region]: null } : current,
          );
        };
      },
    );
    return (
      <div
        {...props}
        ref={targetRef}
        data-slot={`panel-topbar-${region}-target`}
        className={cn("contents", className)}
      />
    );
  }

  function Portal({
    children,
    fallback = null,
  }: {
    children: ReactNode;
    /** Inline controls for standalone views or a mobile panel without a topbar. */
    fallback?: ReactNode;
  }) {
    const context = use(TopbarContext);
    const target = context?.targets[region];
    return target ? createPortal(children, target) : fallback;
  }

  return Object.assign(TopbarRegion, { Target, Portal });
}

function PanelContent({
  className,
  mode = "canvas",
  ...props
}: ComponentPropsWithoutRef<"div"> & { mode?: "canvas" | "scroll" }) {
  return (
    <div
      {...props}
      data-slot="panel-content"
      data-mode={mode}
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col",
        mode === "scroll" ? "overflow-auto" : "overflow-hidden",
        className,
      )}
    />
  );
}

export const Panel = Object.assign(PanelRoot, {
  Topbar: Object.assign(PanelTopbar, {
    Left: createTopbarRegion("left", "shrink overflow-hidden"),
    Center: createTopbarRegion("center", "flex-1 justify-center"),
    Right: createTopbarRegion("right", "shrink justify-end"),
  }),
  Content: PanelContent,
});
