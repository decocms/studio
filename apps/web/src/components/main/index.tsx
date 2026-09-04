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
type MainToolbarRegion = "toolbar-left" | "toolbar-center" | "toolbar-right";
type MainPortalRegion =
  | MainTopbarRegion
  | MainToolbarRegion
  | "breadcrumb-parent"
  | "toolbar"
  | "title";

type PortalTarget = HTMLElement | null;
type PortalTargetSetter = Dispatch<SetStateAction<PortalTarget>>;
type OrderedPortalContents = readonly HTMLElement[];
type OrderedPortalContentsSetter = Dispatch<
  SetStateAction<OrderedPortalContents>
>;
type ToolbarPortalContentsSetter = Dispatch<
  SetStateAction<ReadonlySet<HTMLElement>>
>;

interface MainTopbarContextValue {
  breadcrumbParentFocusRevision: MutableRefObject<number>;
  targets: Record<MainPortalRegion, PortalTarget>;
  breadcrumbParentPortalContents: OrderedPortalContents;
  toolbarPortalContents: ReadonlySet<HTMLElement>;
  titlePortalContents: OrderedPortalContents;
  setBreadcrumbParentTarget: PortalTargetSetter;
  setBreadcrumbParentPortalContents: OrderedPortalContentsSetter;
  setLeftTarget: PortalTargetSetter;
  setCenterTarget: PortalTargetSetter;
  setRightTarget: PortalTargetSetter;
  setToolbarTarget: PortalTargetSetter;
  setToolbarLeftTarget: PortalTargetSetter;
  setToolbarCenterTarget: PortalTargetSetter;
  setToolbarRightTarget: PortalTargetSetter;
  setToolbarPortalContents: ToolbarPortalContentsSetter;
  setTitleTarget: PortalTargetSetter;
  setTitlePortalContents: OrderedPortalContentsSetter;
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

/** Toolbar contributors are intentionally composable: a settings group can
 * provide compact navigation while its leaf contributes filters beside it. */
function useToolbarPortalContentRef(
  setContents: ToolbarPortalContentsSetter,
): RefCallback<HTMLElement> {
  const [contentRef] = useState<RefCallback<HTMLElement>>(
    () => (node: HTMLElement | null) => {
      if (!node) return;
      setContents((current) => new Set(current).add(node));
      return () => {
        setContents((current) => {
          if (!current.has(node)) return current;
          const next = new Set(current);
          next.delete(node);
          return next;
        });
      };
    },
  );
  return contentRef;
}

/** Route transitions may briefly mount the old and next contributors together.
 * Preserve their order and let the newest live owner win instead of crashing
 * or exposing two page titles at once. */
function useOrderedPortalContentRef(
  setContents: OrderedPortalContentsSetter,
): readonly [RefCallback<HTMLElement>, HTMLElement | null] {
  const [content, setContent] = useState<HTMLElement | null>(null);
  const [contentRef] = useState<RefCallback<HTMLElement>>(
    () => (node: HTMLElement | null) => {
      if (!node) return;
      setContent(node);
      setContents((current) => [
        ...current.filter((candidate) => candidate !== node),
        node,
      ]);
      return () => {
        setContent((current) => (current === node ? null : current));
        setContents((current) =>
          current.includes(node)
            ? current.filter((candidate) => candidate !== node)
            : current,
        );
      };
    },
  );

  return [contentRef, content];
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
  setContents: OrderedPortalContentsSetter,
  focusHandoffRevision: MutableRefObject<number>,
): readonly [RefCallback<HTMLElement>, HTMLElement | null] {
  const [content, setContent] = useState<HTMLElement | null>(null);
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

      setContent(node);
      setContents((current) => [
        ...current.filter((candidate) => candidate !== node),
        node,
      ]);
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
        const hasOtherDynamicParent = Array.from(
          node.parentElement?.querySelectorAll<HTMLElement>(
            '[data-slot="main-breadcrumb-parent-portal-content"]',
          ) ?? [],
        ).some((candidate) => candidate !== node);
        setContent((current) => (current === node ? null : current));
        setContents((current) =>
          current.includes(node)
            ? current.filter((candidate) => candidate !== node)
            : current,
        );
        if (root && focused && window.location.pathname === attachedPathname) {
          scheduleBreadcrumbParentFocusHandoff(
            root,
            focused,
            hasOtherDynamicParent ? "dynamic" : "static",
            () => focusHandoffRevision.current === cleanupRevision,
          );
        }
      };
    },
  );

  return [contentRef, content];
}

function MainRoot({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  const [leftTarget, setLeftTarget] = useState<PortalTarget>(null);
  const [centerTarget, setCenterTarget] = useState<PortalTarget>(null);
  const [rightTarget, setRightTarget] = useState<PortalTarget>(null);
  const [toolbarTarget, setToolbarTarget] = useState<PortalTarget>(null);
  const [toolbarLeftTarget, setToolbarLeftTarget] =
    useState<PortalTarget>(null);
  const [toolbarCenterTarget, setToolbarCenterTarget] =
    useState<PortalTarget>(null);
  const [toolbarRightTarget, setToolbarRightTarget] =
    useState<PortalTarget>(null);
  const [toolbarPortalContents, setToolbarPortalContents] = useState<
    ReadonlySet<HTMLElement>
  >(() => new Set());
  const [breadcrumbParentTarget, setBreadcrumbParentTarget] =
    useState<PortalTarget>(null);
  const breadcrumbParentFocusRevision = useRef(0);
  const [breadcrumbParentPortalContents, setBreadcrumbParentPortalContents] =
    useState<OrderedPortalContents>([]);
  const [titleTarget, setTitleTarget] = useState<PortalTarget>(null);
  const [titlePortalContents, setTitlePortalContents] =
    useState<OrderedPortalContents>([]);

  return (
    <MainTopbarContext
      value={{
        breadcrumbParentFocusRevision,
        targets: {
          "breadcrumb-parent": breadcrumbParentTarget,
          left: leftTarget,
          center: centerTarget,
          right: rightTarget,
          toolbar: toolbarTarget,
          "toolbar-left": toolbarLeftTarget,
          "toolbar-center": toolbarCenterTarget,
          "toolbar-right": toolbarRightTarget,
          title: titleTarget,
        },
        breadcrumbParentPortalContents,
        toolbarPortalContents,
        titlePortalContents,
        setBreadcrumbParentTarget,
        setBreadcrumbParentPortalContents,
        setLeftTarget,
        setCenterTarget,
        setRightTarget,
        setToolbarTarget,
        setToolbarLeftTarget,
        setToolbarCenterTarget,
        setToolbarRightTarget,
        setToolbarPortalContents,
        setTitleTarget,
        setTitlePortalContents,
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

function MainToolbar({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  const { setToolbarTarget, toolbarPortalContents } = useMainTopbarContext();
  const targetRef = usePortalTargetRef("toolbar", setToolbarTarget);
  const compactOnly =
    toolbarPortalContents.size > 0 &&
    Array.from(toolbarPortalContents).every(
      (content) => content.dataset.toolbarVisibility === "compact",
    );

  return (
    <div
      {...props}
      ref={targetRef}
      data-slot="main-toolbar"
      className={cn(
        "flex min-w-0 shrink-0 flex-wrap items-center gap-2 border-b border-border/60 bg-background px-3 py-2 empty:hidden",
        compactOnly && "md:hidden",
        className,
      )}
    >
      {children}
    </div>
  );
}

function MainToolbarPortal({
  children,
  visibility = "always",
}: {
  children: ReactNode;
  /** Compact contributions relocate a control already present in the topbar. */
  visibility?: "always" | "compact";
}) {
  const { targets, setToolbarPortalContents } = useMainTopbarContext();
  const target = targets.toolbar;
  const contentRef = useToolbarPortalContentRef(setToolbarPortalContents);

  return target
    ? createPortal(
        <div
          ref={contentRef}
          data-slot="main-toolbar-portal-content"
          data-toolbar-visibility={visibility}
          className={cn("contents", visibility === "compact" && "md:hidden")}
        >
          {children}
        </div>,
        target,
      )
    : null;
}

function MainToolbarRegionContainer({
  children,
  className,
  region,
  ...props
}: ComponentPropsWithoutRef<"div"> & { region: MainToolbarRegion }) {
  return (
    <div
      {...props}
      data-slot={`main-${region}`}
      className={cn(
        "flex min-w-0 items-center gap-1",
        region === "toolbar-center" && "justify-center",
        region === "toolbar-right" && "justify-end",
        className,
      )}
    >
      {children}
    </div>
  );
}

function MainToolbarLeft(props: ComponentPropsWithoutRef<"div">) {
  return <MainToolbarRegionContainer {...props} region="toolbar-left" />;
}

function MainToolbarCenter(props: ComponentPropsWithoutRef<"div">) {
  return <MainToolbarRegionContainer {...props} region="toolbar-center" />;
}

function MainToolbarRight(props: ComponentPropsWithoutRef<"div">) {
  return <MainToolbarRegionContainer {...props} region="toolbar-right" />;
}

function MainToolbarRegionTarget({
  region,
  ...props
}: MainTopbarTargetProps & { region: MainToolbarRegion }) {
  const {
    setToolbarCenterTarget,
    setToolbarLeftTarget,
    setToolbarRightTarget,
  } = useMainTopbarContext();
  const setTarget =
    region === "toolbar-left"
      ? setToolbarLeftTarget
      : region === "toolbar-center"
        ? setToolbarCenterTarget
        : setToolbarRightTarget;
  const targetRef = usePortalTargetRef(region, setTarget);

  return (
    <div
      {...props}
      ref={targetRef}
      data-slot={`main-${region}-portal-target`}
      className={cn("contents", props.className)}
    />
  );
}

function MainToolbarLeftTarget(props: MainTopbarTargetProps) {
  return <MainToolbarRegionTarget {...props} region="toolbar-left" />;
}

function MainToolbarCenterTarget(props: MainTopbarTargetProps) {
  return <MainToolbarRegionTarget {...props} region="toolbar-center" />;
}

function MainToolbarRightTarget(props: MainTopbarTargetProps) {
  return <MainToolbarRegionTarget {...props} region="toolbar-right" />;
}

function MainToolbarRegionPortal({
  children,
  region,
}: {
  children: ReactNode;
  region: MainToolbarRegion;
}) {
  const { targets } = useMainTopbarContext();
  const target = targets[region];

  return target ? createPortal(children, target) : null;
}

function MainToolbarLeftPortal({ children }: { children: ReactNode }) {
  return (
    <MainToolbarRegionPortal region="toolbar-left">
      {children}
    </MainToolbarRegionPortal>
  );
}

function MainToolbarCenterPortal({ children }: { children: ReactNode }) {
  return (
    <MainToolbarRegionPortal region="toolbar-center">
      {children}
    </MainToolbarRegionPortal>
  );
}

function MainToolbarRightPortal({ children }: { children: ReactNode }) {
  return (
    <MainToolbarRegionPortal region="toolbar-right">
      {children}
    </MainToolbarRegionPortal>
  );
}

function MainContent({
  children,
  className,
  mode = "scroll",
  ...props
}: ComponentPropsWithoutRef<"div"> & {
  /**
   * A route has exactly one scroll owner. Document and collection pages let
   * Main own it; editors and dashboards that coordinate nested panes opt into
   * canvas mode and provide their own, local scroll regions.
   */
  mode?: "scroll" | "canvas";
}) {
  return (
    <div
      {...props}
      data-slot="main-content"
      data-mode={mode}
      className={cn(
        "@container [container-name:main-content] relative flex min-h-0 min-w-0 flex-1 flex-col",
        mode === "scroll" ? "overflow-auto" : "overflow-hidden",
        className,
      )}
    >
      {children}
    </div>
  );
}

type MainContainerWidth = "reading" | "standard" | "wide" | "fluid";
type MainContainerPadding = "normal" | "compact" | "none";

const MAIN_CONTAINER_WIDTH: Record<MainContainerWidth, string> = {
  reading: "max-w-3xl",
  standard: "max-w-5xl",
  wide: "max-w-7xl",
  fluid: "max-w-none",
};

const MAIN_CONTAINER_PADDING: Record<MainContainerPadding, string> = {
  normal: "px-4 py-6 @lg:px-6 @4xl:px-8 @4xl:py-8 @6xl:px-10",
  compact: "px-4 py-4 @lg:px-6 @4xl:px-8",
  none: "p-0",
};

/**
 * The shared reading frame for non-canvas routes. Width communicates content
 * type, while one padding scale keeps every destination aligned when moving
 * through the sidebar.
 */
function MainContainer({
  children,
  className,
  width = "wide",
  padding = "normal",
  ...props
}: ComponentPropsWithoutRef<"div"> & {
  width?: MainContainerWidth;
  padding?: MainContainerPadding;
}) {
  return (
    <div
      {...props}
      data-slot="main-container"
      data-width={width}
      data-padding={padding}
      className={cn(
        "mx-auto w-full",
        MAIN_CONTAINER_WIDTH[width],
        MAIN_CONTAINER_PADDING[padding],
        className,
      )}
    >
      {children}
    </div>
  );
}

function MainStack({
  children,
  className,
  gap = "default",
  ...props
}: ComponentPropsWithoutRef<"div"> & {
  gap?: "compact" | "default" | "spacious";
}) {
  return (
    <div
      {...props}
      data-slot="main-stack"
      data-gap={gap}
      className={cn(
        "flex min-w-0 flex-col",
        gap === "compact" ? "gap-4" : gap === "spacious" ? "gap-10" : "gap-6",
        className,
      )}
    >
      {children}
    </div>
  );
}

function MainSection({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<"section">) {
  return (
    <section
      {...props}
      data-slot="main-section"
      className={cn("flex min-w-0 flex-col gap-3", className)}
    >
      {children}
    </section>
  );
}

function MainSectionHeader({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      {...props}
      data-slot="main-section-header"
      className={cn(
        "flex min-w-0 flex-wrap items-start justify-between gap-3",
        className,
      )}
    >
      {children}
    </div>
  );
}

function MainSectionTitle({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<"h2">) {
  return (
    <h2
      {...props}
      data-slot="main-section-title"
      className={cn("text-sm font-medium text-foreground", className)}
    >
      {children}
    </h2>
  );
}

function MainSectionDescription({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<"p">) {
  return (
    <p
      {...props}
      data-slot="main-section-description"
      className={cn(
        "max-w-prose text-sm leading-relaxed text-muted-foreground",
        className,
      )}
    >
      {children}
    </p>
  );
}

function MainSectionActions({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      {...props}
      data-slot="main-section-actions"
      className={cn("flex shrink-0 flex-wrap items-center gap-2", className)}
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
  const { breadcrumbParentPortalContents, setBreadcrumbParentTarget } =
    useMainTopbarContext();
  const targetRef = usePortalTargetRef(
    "breadcrumb-parent",
    setBreadcrumbParentTarget,
  );

  return children({
    present: breadcrumbParentPortalContents.length > 0,
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
    breadcrumbParentPortalContents,
    targets,
    setBreadcrumbParentPortalContents,
  } = useMainTopbarContext();
  const [contentRef, content] = useBreadcrumbParentPortalContentRef(
    setBreadcrumbParentPortalContents,
    breadcrumbParentFocusRevision,
  );
  const target = targets["breadcrumb-parent"];
  const active =
    content !== null &&
    breadcrumbParentPortalContents[
      breadcrumbParentPortalContents.length - 1
    ] === content;

  return target
    ? createPortal(
        <span
          ref={contentRef}
          data-slot="main-breadcrumb-parent-portal-content"
          data-active={active ? "true" : "false"}
          hidden={!active}
          className={cn("contents", !active && "hidden")}
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
  const { setTitleTarget, titlePortalContents } = useMainTopbarContext();
  const targetRef = usePortalTargetRef("title", setTitleTarget);

  return (
    <>
      {titlePortalContents.length > 0 ? null : fallback}
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
  const { targets, setTitlePortalContents, titlePortalContents } =
    useMainTopbarContext();
  const [contentRef, content] = useOrderedPortalContentRef(
    setTitlePortalContents,
  );
  const target = targets.title;
  const active =
    content !== null &&
    titlePortalContents[titlePortalContents.length - 1] === content;

  return target
    ? createPortal(
        <span
          ref={contentRef}
          data-slot="main-title-portal-content"
          data-active={active ? "true" : "false"}
          hidden={!active}
          className={cn("contents", !active && "hidden")}
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
  /** The one optional contextual row below the route topbar. */
  Toolbar: Object.assign(MainToolbar, {
    Portal: MainToolbarPortal,
    Left: Object.assign(MainToolbarLeft, {
      Portal: MainToolbarLeftPortal,
      Target: MainToolbarLeftTarget,
    }),
    Center: Object.assign(MainToolbarCenter, {
      Portal: MainToolbarCenterPortal,
      Target: MainToolbarCenterTarget,
    }),
    Right: Object.assign(MainToolbarRight, {
      Portal: MainToolbarRightPortal,
      Target: MainToolbarRightTarget,
    }),
  }),
  Content: MainContent,
  Container: MainContainer,
  Drawer: MainDrawer,
  Section: Object.assign(MainSection, {
    Actions: MainSectionActions,
    Description: MainSectionDescription,
    Header: MainSectionHeader,
    Title: MainSectionTitle,
  }),
  Stack: MainStack,
  Title: Object.assign(MainTitle, {
    Portal: MainTitlePortal,
    Target: MainTitleTarget,
  }),
});
