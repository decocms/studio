import { cn } from "@decocms/ui/lib/utils.ts";
import {
  createContext,
  use,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type Dispatch,
  type MutableRefObject,
  type RefCallback,
  type ReactNode,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";

type MainTopbarRegion = "left" | "center" | "right";
type MainPortalRegion =
  | MainTopbarRegion
  | "breadcrumb-parent"
  | "subheader"
  | "subheader-center"
  | "title";

type PortalTarget = HTMLElement | null;
type PortalTargetSetter = Dispatch<SetStateAction<PortalTarget>>;

interface MainTopbarContextValue {
  breadcrumbParentFocusRevision: MutableRefObject<number>;
  targets: Record<MainPortalRegion, PortalTarget>;
  breadcrumbParentPortalContent: PortalTarget;
  titlePortalContent: PortalTarget;
  setBreadcrumbParentTarget: PortalTargetSetter;
  setBreadcrumbParentPortalContent: PortalTargetSetter;
  setLeftTarget: PortalTargetSetter;
  setCenterTarget: PortalTargetSetter;
  setRightTarget: PortalTargetSetter;
  setSubheaderTarget: PortalTargetSetter;
  setSubheaderCenterTarget: PortalTargetSetter;
  setTitleTarget: PortalTargetSetter;
  setTitlePortalContent: PortalTargetSetter;
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
  region: string,
  setTarget: PortalTargetSetter,
): RefCallback<HTMLElement> {
  const [targetRef] = useState<RefCallback<HTMLElement>>(
    () => (node: HTMLElement | null) => {
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

type BreadcrumbParentFocusDestination = "dynamic" | "static";

function scheduleBreadcrumbParentFocusHandoff(
  root: HTMLElement,
  source: HTMLElement,
  destination: BreadcrumbParentFocusDestination,
  isCurrent: () => boolean,
): void {
  requestAnimationFrame(() => {
    if (!isCurrent() || !root.isConnected) return;
    const active = document.activeElement;
    if (active !== source && active !== document.body) return;

    const selectors =
      destination === "dynamic"
        ? [
            '[data-slot="main-breadcrumb-dynamic-parent"] a[href]',
            '[data-slot="main-breadcrumb-dynamic-parent"] button:not([disabled])',
          ]
        : [
            '[data-slot="main-breadcrumb-ancestor"] a[href]',
            '[data-slot="main-breadcrumb-ancestor"] button:not([disabled])',
            '[data-slot="main-breadcrumb-overflow-trigger"]',
            '[data-slot="main-breadcrumb-scope"] a[href]',
            '[data-slot="main-breadcrumb-scope"] button:not([disabled])',
          ];
    const target = selectors
      .map((selector) => root.querySelector<HTMLElement>(selector))
      .find((candidate) => candidate && candidate.getClientRects().length > 0);
    target?.focus({ preventScroll: true });
  });
}

/** Preserve breadcrumb focus when an async route parent replaces its fallback. */
function useBreadcrumbParentPortalContentRef(
  setTarget: PortalTargetSetter,
  focusHandoffRevision: MutableRefObject<number>,
): RefCallback<HTMLElement> {
  const [contentRef] = useState<RefCallback<HTMLElement>>(
    () => (node: HTMLElement | null) => {
      if (!node) return;

      const root = node.closest<HTMLElement>('[data-slot="main"]');
      const active =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      const staticSource = active?.closest(
        '[data-slot="main-breadcrumb-ancestor"]',
      )
        ? active
        : null;
      const attachedPathname = window.location.pathname;
      const attachRevision = ++focusHandoffRevision.current;

      setTarget((current) => {
        if (current && current !== node) {
          throw new Error(
            "Main.breadcrumb-parent-portal-content can only have one live portal target",
          );
        }
        return node;
      });
      if (root && staticSource) {
        scheduleBreadcrumbParentFocusHandoff(
          root,
          staticSource,
          "dynamic",
          () => focusHandoffRevision.current === attachRevision,
        );
      }

      return () => {
        const focused =
          document.activeElement instanceof HTMLElement &&
          node.contains(document.activeElement)
            ? document.activeElement
            : null;
        const cleanupRevision = ++focusHandoffRevision.current;
        setTarget((current) => (current === node ? null : current));
        if (root && focused && window.location.pathname === attachedPathname) {
          scheduleBreadcrumbParentFocusHandoff(
            root,
            focused,
            "static",
            () => focusHandoffRevision.current === cleanupRevision,
          );
        }
      };
    },
  );

  return contentRef;
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
  const [subheaderCenterTarget, setSubheaderCenterTarget] =
    useState<PortalTarget>(null);
  const [breadcrumbParentTarget, setBreadcrumbParentTarget] =
    useState<PortalTarget>(null);
  const breadcrumbParentFocusRevision = useRef(0);
  const [breadcrumbParentPortalContent, setBreadcrumbParentPortalContent] =
    useState<PortalTarget>(null);
  const [titleTarget, setTitleTarget] = useState<PortalTarget>(null);
  const [titlePortalContent, setTitlePortalContent] =
    useState<PortalTarget>(null);

  return (
    <MainTopbarContext
      value={{
        breadcrumbParentFocusRevision,
        targets: {
          "breadcrumb-parent": breadcrumbParentTarget,
          left: leftTarget,
          center: centerTarget,
          right: rightTarget,
          subheader: subheaderTarget,
          "subheader-center": subheaderCenterTarget,
          title: titleTarget,
        },
        breadcrumbParentPortalContent,
        titlePortalContent,
        setBreadcrumbParentTarget,
        setBreadcrumbParentPortalContent,
        setLeftTarget,
        setCenterTarget,
        setRightTarget,
        setSubheaderTarget,
        setSubheaderCenterTarget,
        setTitleTarget,
        setTitlePortalContent,
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
        "@container [container-name:main-topbar-left] col-start-1 row-start-1 flex min-w-0 items-center gap-1 overflow-hidden justify-self-stretch",
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

function MainSubheaderCenterTarget(props: MainTopbarTargetProps) {
  const { setSubheaderCenterTarget } = useMainTopbarContext();
  const targetRef = usePortalTargetRef(
    "subheader-center",
    setSubheaderCenterTarget,
  );

  return (
    <div
      {...props}
      ref={targetRef}
      data-slot="main-subheader-center-portal-target"
      className={cn("contents", props.className)}
    />
  );
}

function MainSubheaderCenterPortal({ children }: { children: ReactNode }) {
  const { targets } = useMainTopbarContext();
  const target = targets["subheader-center"];

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

interface MainBreadcrumbParentTargetRenderState {
  /** A route contribution is mounted in this target. */
  present: boolean;
  /** Keep this node mounted even while `present` is false. */
  target: ReactNode;
}

function MainBreadcrumbParentTarget({
  children,
}: {
  children: (state: MainBreadcrumbParentTargetRenderState) => ReactNode;
}) {
  const { breadcrumbParentPortalContent, setBreadcrumbParentTarget } =
    useMainTopbarContext();
  const targetRef = usePortalTargetRef(
    "breadcrumb-parent",
    setBreadcrumbParentTarget,
  );

  return children({
    present: Boolean(breadcrumbParentPortalContent),
    target: (
      <span
        ref={targetRef}
        data-slot="main-breadcrumb-parent-portal-target"
        className="contents"
      />
    ),
  });
}

function MainBreadcrumbParentPortal({ children }: { children: ReactNode }) {
  const {
    breadcrumbParentFocusRevision,
    targets,
    setBreadcrumbParentPortalContent,
  } = useMainTopbarContext();
  const contentRef = useBreadcrumbParentPortalContentRef(
    setBreadcrumbParentPortalContent,
    breadcrumbParentFocusRevision,
  );
  const target = targets["breadcrumb-parent"];

  return target
    ? createPortal(
        <span
          ref={contentRef}
          data-slot="main-breadcrumb-parent-portal-content"
          className="contents"
        >
          {children}
        </span>,
        target,
      )
    : null;
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

type MainTitleTargetProps = Omit<
  ComponentPropsWithoutRef<"span">,
  "children"
> & {
  fallback: ReactNode;
};

function MainTitleTarget({
  fallback,
  className,
  ...props
}: MainTitleTargetProps) {
  const { setTitleTarget, titlePortalContent } = useMainTopbarContext();
  const targetRef = usePortalTargetRef("title", setTitleTarget);

  return (
    <>
      {titlePortalContent ? null : fallback}
      <span
        {...props}
        ref={targetRef}
        data-slot="main-title-portal-target"
        className={cn("contents", className)}
      />
    </>
  );
}

function MainTitlePortal({ children }: { children: ReactNode }) {
  const { targets, setTitlePortalContent } = useMainTopbarContext();
  const contentRef = usePortalTargetRef(
    "title-portal-content",
    setTitlePortalContent,
  );
  const target = targets.title;

  return target
    ? createPortal(
        <span
          ref={contentRef}
          data-slot="main-title-portal-content"
          className="contents"
        >
          {children}
        </span>,
        target,
      )
    : null;
}

export const Main = Object.assign(MainRoot, {
  Breadcrumb: {
    Parent: {
      Portal: MainBreadcrumbParentPortal,
      Target: MainBreadcrumbParentTarget,
    },
  },
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
    Center: {
      Portal: MainSubheaderCenterPortal,
      Target: MainSubheaderCenterTarget,
    },
  }),
  Content: MainContent,
  Drawer: MainDrawer,
  Title: Object.assign(MainTitle, {
    Portal: MainTitlePortal,
    Target: MainTitleTarget,
  }),
});
