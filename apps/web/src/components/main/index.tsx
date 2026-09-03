import { cn } from "@decocms/ui/lib/utils.ts";
import {
  createContext,
  use,
  useState,
  type ComponentPropsWithoutRef,
  type Dispatch,
  type RefCallback,
  type ReactNode,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";

type MainTopbarRegion = "left" | "center" | "right";
type MainPortalRegion = MainTopbarRegion | "subheader";

type PortalTarget = HTMLDivElement | null;
type PortalTargetSetter = Dispatch<SetStateAction<PortalTarget>>;

interface MainTopbarContextValue {
  targets: Record<MainPortalRegion, PortalTarget>;
  setLeftTarget: PortalTargetSetter;
  setCenterTarget: PortalTargetSetter;
  setRightTarget: PortalTargetSetter;
  setSubheaderTarget: PortalTargetSetter;
}

const MainTopbarContext = createContext<MainTopbarContextValue | null>(null);

function useMainTopbarContext(): MainTopbarContextValue {
  const context = use(MainTopbarContext);
  if (!context) {
    throw new Error("Main slot components must be used inside <Main>");
  }
  return context;
}

/**
 * A stable callback ref with identity-safe cleanup. The identity check matters
 * when React replaces a target in one commit: cleanup for the old node must not
 * clear the replacement that registered after it. A second live target for the
 * same region is a composition error because portal and keyboard order would
 * otherwise depend on ref commit order.
 */
function usePortalTargetRef(
  region: MainPortalRegion,
  setTarget: PortalTargetSetter,
): RefCallback<HTMLDivElement> {
  const [targetRef] = useState<RefCallback<HTMLDivElement>>(
    () => (node: HTMLDivElement | null) => {
      if (!node) return;

      setTarget((current) => {
        if (current && current !== node) {
          throw new Error(
            `Main.${region} can only have one live portal target`,
          );
        }
        return node;
      });

      return () => {
        setTarget((current) => (current === node ? null : current));
      };
    },
  );

  return targetRef;
}

function MainRoot({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  const [leftTarget, setLeftTarget] = useState<PortalTarget>(null);
  const [centerTarget, setCenterTarget] = useState<PortalTarget>(null);
  const [rightTarget, setRightTarget] = useState<PortalTarget>(null);
  const [subheaderTarget, setSubheaderTarget] = useState<PortalTarget>(null);

  return (
    <MainTopbarContext
      value={{
        targets: {
          left: leftTarget,
          center: centerTarget,
          right: rightTarget,
          subheader: subheaderTarget,
        },
        setLeftTarget,
        setCenterTarget,
        setRightTarget,
        setSubheaderTarget,
      }}
    >
      <div
        {...props}
        data-slot="main"
        className={cn(
          "flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background",
          className,
        )}
      >
        {children}
      </div>
    </MainTopbarContext>
  );
}

function MainTopbar({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<"header">) {
  return (
    <header
      {...props}
      data-slot="main-topbar"
      className={cn(
        "@container [container-name:main-topbar_panel-header] relative z-10 grid h-12 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-b border-border/60 bg-background px-1.5",
        className,
      )}
    >
      {children}
    </header>
  );
}

function MainTopbarLeft({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  useMainTopbarContext();

  return (
    <div
      {...props}
      data-slot="main-topbar-left"
      className={cn(
        "col-start-1 row-start-1 flex min-w-0 items-center gap-1 overflow-hidden justify-self-stretch",
        className,
      )}
    >
      {children}
    </div>
  );
}

function MainTopbarCenter({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  useMainTopbarContext();

  return (
    <div
      {...props}
      data-slot="main-topbar-center"
      className={cn(
        "col-start-2 row-start-1 flex min-w-0 items-center justify-center gap-1 justify-self-center",
        className,
      )}
    >
      {children}
    </div>
  );
}

function MainTopbarRight({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  useMainTopbarContext();

  return (
    <div
      {...props}
      data-slot="main-topbar-right"
      className={cn(
        "col-start-3 row-start-1 flex min-w-0 items-center justify-end gap-1 overflow-hidden justify-self-stretch",
        className,
      )}
    >
      {children}
    </div>
  );
}

type MainTopbarTargetProps = Omit<ComponentPropsWithoutRef<"div">, "children">;

function MainTopbarTarget({
  region,
  className,
  ...props
}: MainTopbarTargetProps & { region: MainTopbarRegion }) {
  const { setLeftTarget, setCenterTarget, setRightTarget } =
    useMainTopbarContext();
  const setTarget =
    region === "left"
      ? setLeftTarget
      : region === "center"
        ? setCenterTarget
        : setRightTarget;
  const targetRef = usePortalTargetRef(region, setTarget);

  return (
    <div
      {...props}
      ref={targetRef}
      data-slot={`main-topbar-${region}-portal-target`}
      className={cn("contents", className)}
    />
  );
}

function MainTopbarLeftTarget(props: MainTopbarTargetProps) {
  return <MainTopbarTarget {...props} region="left" />;
}

function MainTopbarCenterTarget(props: MainTopbarTargetProps) {
  return <MainTopbarTarget {...props} region="center" />;
}

function MainTopbarRightTarget(props: MainTopbarTargetProps) {
  return <MainTopbarTarget {...props} region="right" />;
}

function MainTopbarPortal({
  children,
  fallback = null,
  region,
}: {
  children: ReactNode;
  fallback?: ReactNode;
  region: MainTopbarRegion;
}) {
  const { targets } = useMainTopbarContext();
  const target = targets[region];

  return target ? createPortal(children, target) : fallback;
}

type MainTopbarRegionPortalProps = Omit<
  Parameters<typeof MainTopbarPortal>[0],
  "region"
>;

function MainTopbarLeftPortal(props: MainTopbarRegionPortalProps) {
  return <MainTopbarPortal {...props} region="left" />;
}

function MainTopbarCenterPortal(props: MainTopbarRegionPortalProps) {
  return <MainTopbarPortal {...props} region="center" />;
}

function MainTopbarRightPortal(props: MainTopbarRegionPortalProps) {
  return <MainTopbarPortal {...props} region="right" />;
}

function MainSubheader({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  const { setSubheaderTarget } = useMainTopbarContext();
  const targetRef = usePortalTargetRef("subheader", setSubheaderTarget);

  return (
    <div
      {...props}
      ref={targetRef}
      data-slot="main-subheader"
      className={cn(
        "flex shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3 py-2 empty:hidden",
        className,
      )}
    >
      {children}
    </div>
  );
}

function MainSubheaderPortal({ children }: { children: ReactNode }) {
  const { targets } = useMainTopbarContext();
  const target = targets.subheader;

  return target ? createPortal(children, target) : null;
}

function MainContent({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      {...props}
      data-slot="main-content"
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-auto",
        className,
      )}
    >
      {children}
    </div>
  );
}

function MainDrawer({ children }: { children?: ReactNode }) {
  return children;
}

function MainTitle({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<"h1">) {
  return (
    <h1
      {...props}
      data-slot="main-title"
      className={cn(
        "min-w-0 truncate text-sm leading-none font-medium text-foreground",
        className,
      )}
    >
      {children}
    </h1>
  );
}

export const Main = Object.assign(MainRoot, {
  Topbar: Object.assign(MainTopbar, {
    Left: Object.assign(MainTopbarLeft, {
      Portal: MainTopbarLeftPortal,
      Target: MainTopbarLeftTarget,
    }),
    Center: Object.assign(MainTopbarCenter, {
      Portal: MainTopbarCenterPortal,
      Target: MainTopbarCenterTarget,
    }),
    Right: Object.assign(MainTopbarRight, {
      Portal: MainTopbarRightPortal,
      Target: MainTopbarRightTarget,
    }),
  }),
  Subheader: Object.assign(MainSubheader, {
    Portal: MainSubheaderPortal,
  }),
  Content: MainContent,
  Drawer: MainDrawer,
  Title: MainTitle,
});
