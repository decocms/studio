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

type Region =
  | "left"
  | "center"
  | "right"
  | "toolbar-left"
  | "toolbar-center"
  | "toolbar-right";
type Targets = Record<Region, HTMLDivElement | null>;

const PanelSlotsContext = createContext<{
  targets: Targets;
  setTargets: Dispatch<SetStateAction<Targets>>;
} | null>(null);

/** A visual surface. Layouts own placement; routes own contents. */
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
    "toolbar-left": null,
    "toolbar-center": null,
    "toolbar-right": null,
  });

  return (
    <PanelSlotsContext value={{ targets, setTargets }}>
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
    </PanelSlotsContext>
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

function createPanelRegion(region: Region, regionClassName: string) {
  const slot = region.startsWith("toolbar-")
    ? `panel-${region}`
    : `panel-topbar-${region}`;
  function TopbarRegion({
    className,
    ...props
  }: ComponentPropsWithoutRef<"div">) {
    return (
      <div
        {...props}
        data-slot={slot}
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
    fallback,
    ...props
  }: Omit<ComponentPropsWithoutRef<"div">, "children"> & {
    fallback?: ReactNode;
  }) {
    const context = use(PanelSlotsContext);
    if (!context) throw new Error("Panel targets require a Panel");
    const { setTargets } = context;
    // Ref cleanup may run after a replacement attaches during a route transition.
    const [targetRef] = useState<RefCallback<HTMLDivElement>>(
      () => (node: HTMLDivElement | null) => {
        if (!node) return;
        setTargets((current) => {
          if (current[region] && current[region] !== node) {
            throw new Error(`Panel has two targets for ${region}`);
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
      <>
        <div
          data-toolbar-content={region.startsWith("toolbar-") ? "" : undefined}
          {...props}
          ref={targetRef}
          data-slot={`${slot}-target`}
          className={cn("peer contents empty:hidden", className)}
        />
        {fallback && (
          <div className="hidden peer-empty:contents">{fallback}</div>
        )}
      </>
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
    const context = use(PanelSlotsContext);
    const target = context?.targets[region];
    return target ? createPortal(children, target) : fallback;
  }

  return Object.assign(TopbarRegion, { Target, Portal });
}

/** Empty toolbars disappear when their last route-owned portal unmounts. */
function PanelToolbar({
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      {...props}
      data-slot="panel-toolbar"
      className={cn(
        "@container/panel-toolbar relative z-10 flex min-h-11 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5 [&:not(:has([data-toolbar-content]:not(:empty)))]:hidden",
        className,
      )}
    />
  );
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
    Left: createPanelRegion("left", "shrink overflow-hidden"),
    Center: createPanelRegion("center", "flex-1 justify-center"),
    Right: createPanelRegion("right", "shrink justify-end"),
  }),
  Toolbar: Object.assign(PanelToolbar, {
    Left: createPanelRegion("toolbar-left", "shrink"),
    Center: createPanelRegion("toolbar-center", "flex-1 justify-center"),
    Right: createPanelRegion("toolbar-right", "ml-auto shrink-0 justify-end"),
  }),
  Content: PanelContent,
});
