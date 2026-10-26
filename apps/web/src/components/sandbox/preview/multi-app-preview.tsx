import { useRef, useState, type ReactNode } from "react";
import {
  Columns02,
  LinkExternal01,
  Monitor04,
  Phone02,
  Plus,
  RefreshCw01,
  XClose,
} from "@untitledui/icons";
import type { RuntimeApp } from "@decocms/shared/sdk/types";
import { useVirtualMCPActions, type VirtualMCPEntity } from "@/sdk";
import { toast } from "sonner";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { useChatTask } from "@/components/chat/context";
import { useSandboxLifecycle } from "@/components/sandbox/hooks/sandbox-lifecycle-context";
import { servePreviewUrl } from "@/components/sections-editor/content-backend";
import { useContentBackend } from "@/components/sections-editor/use-content-backend";
import { Panel } from "@/components/panel";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { useLocalPreviewUrl } from "@/hooks/use-local-preview-url";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { omitSandboxMap } from "@/lib/omit-sandbox-map";
import { Button } from "@decocms/ui/components/button.tsx";
import { useT } from "@/i18n/use-t.ts";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";
import { useSandboxEvents } from "../hooks/use-sandbox-events";
import {
  appLabel,
  appPreviewUrl,
  normalizeAppPath,
  withPagePath,
} from "./app-preview-url";

interface AppLayout {
  /** Path of the extra app on screen; null shows only the main app. */
  app: string | null;
  /** Main app on the left, `app` on the right. */
  split: boolean;
}

const SINGLE_MAIN: AppLayout = { app: null, split: false };

type PaneDevice = "desktop" | "mobile";

/** `MultiAppPreview` over a project's saved apps, writing back to the project. */
export function ProjectMultiAppPreview({
  project,
  maxApps,
  children,
}: {
  project: VirtualMCPEntity;
  maxApps: number;
  children: ReactNode;
}) {
  const t = useT();
  // The new tab is the feedback; only a failed save needs a toast.
  const actions = useVirtualMCPActions({ silent: true });
  const lifecycle = useSandboxLifecycle();
  const runtime = project.metadata.runtime ?? {};
  const apps = runtime.apps ?? [];
  const saveApps = (next: RuntimeApp[]) =>
    actions.update.mutate(
      {
        id: project.id,
        data: {
          metadata: {
            ...omitSandboxMap(project.metadata),
            runtime: { ...runtime, apps: next.length ? next : null },
          },
        },
      },
      {
        // A sandbox learns its apps on SANDBOX_START, which resumes a running one.
        onSuccess: () => lifecycle.start(),
        onError: () => toast.error(t("sandbox.appTabs.saveError")),
      },
    );
  return (
    <MultiAppPreview
      virtualMcpId={project.id}
      mainPath={runtime.path ?? null}
      apps={apps}
      maxApps={maxApps}
      onAddApp={(path) => saveApps([...apps, { path }])}
      onRemoveApp={(path) => saveApps(apps.filter((app) => app.path !== path))}
    >
      {children}
    </MultiAppPreview>
  );
}

/**
 * App tabs beside the page title for a monorepo project. The main app keeps
 * the full editor (`children`) and the chat; each extra app (from
 * `metadata.runtime.apps`) gets a preview-only frame with its own address
 * and device.
 */
function MultiAppPreview({
  virtualMcpId,
  mainPath,
  apps,
  maxApps,
  onAddApp,
  onRemoveApp,
  children,
}: {
  virtualMcpId: string;
  mainPath: string | null;
  apps: RuntimeApp[];
  maxApps: number;
  onAddApp: (path: string) => void;
  onRemoveApp: (path: string) => void;
  children: ReactNode;
}) {
  const t = useT();
  const isMobile = useIsMobile();
  const { currentBranch } = useChatTask();
  const lifecycle = useSandboxLifecycle();
  const phase = useSandboxEvents().lifecycle.phase;
  const contentBackend = useContentBackend(virtualMcpId, currentBranch);
  const { url: tunnelUrl } = useLocalPreviewUrl(virtualMcpId);
  // Same source order as PreviewContent: a local app, then the sandbox.
  const localUrl = servePreviewUrl(contentBackend) ?? tunnelUrl;
  const mainUrl = localUrl ?? lifecycle.previewUrl;
  const ready = !!localUrl || phase === "running";
  const failed = !ready && lifecycle.status === "errored";
  // Apps saved after this sandbox started (e.g. in Settings) aren't running yet.
  const startedApps = lifecycle.vmEntry?.startedWith?.apps ?? [];

  const [storedLayout, setLayout] = useLocalStorage<AppLayout>(
    LOCALSTORAGE_KEYS.previewAppLayout(virtualMcpId),
    (existing) => existing ?? SINGLE_MAIN,
  );
  // A removed app, or a phone, falls back instead of showing an empty pane.
  const extra = apps.some((app) => app.path === storedLayout.app)
    ? storedLayout.app
    : null;
  const split = extra !== null && storedLayout.split && !isMobile;
  const showMain = extra === null || split;
  const splitTarget = extra ?? apps[0]?.path ?? null;

  const [draft, setDraft] = useState<string | null>(null);
  const [draftError, setDraftError] = useState(false);
  const closeDraft = () => {
    setDraft(null);
    setDraftError(false);
  };
  const commitDraft = () => {
    if (draft === null) return;
    const path = normalizeAppPath(draft);
    if (!path) {
      closeDraft();
      return;
    }
    if (
      path === normalizeAppPath(mainPath ?? "") ||
      apps.some((app) => app.path === path)
    ) {
      setDraftError(true);
      return;
    }
    onAddApp(path);
    // The new app opens beside the main one: that is why it was added.
    setLayout({ app: path, split: !isMobile });
    closeDraft();
  };

  const mainLabel = mainPath ? appLabel(mainPath) : t("sandbox.appTabs.root");
  const splitLabel = split
    ? t("sandbox.appTabs.single")
    : t("sandbox.appTabs.split");

  const appBar = (
    <>
      <div
        role="tablist"
        aria-label={t("sandbox.appTabs.label")}
        className="flex min-w-0 items-center gap-1 overflow-x-auto"
      >
        <AppTab
          label={mainLabel}
          badge={t("sandbox.appTabs.main")}
          hint={t("sandbox.appTabs.mainHint")}
          ready={ready}
          failed={failed}
          onScreen={showMain}
          onSelect={() => setLayout(SINGLE_MAIN)}
        />
        {apps.map((app) => {
          const label = appLabel(app.path);
          return (
            <AppTab
              key={app.path}
              label={label}
              hint={t("sandbox.appTabs.extraHint", { app: mainLabel })}
              ready={ready}
              failed={failed}
              onScreen={app.path === extra}
              onSelect={() => setLayout({ app: app.path, split })}
              onRemove={() => onRemoveApp(app.path)}
              removeLabel={t("sandbox.appTabs.remove", { app: label })}
            />
          );
        })}
      </div>
      {draft !== null ? (
        <form
          className="w-40 shrink-0"
          onSubmit={(e) => {
            e.preventDefault();
            commitDraft();
          }}
        >
          <input
            autoFocus
            value={draft}
            placeholder="apps/checkout"
            aria-label={t("sandbox.appTabs.pathLabel")}
            aria-invalid={draftError}
            onChange={(e) => {
              setDraft(e.target.value);
              setDraftError(false);
            }}
            onBlur={closeDraft}
            onKeyDown={(e) => {
              if (e.key === "Escape") closeDraft();
            }}
            className={cn(
              "h-7 w-full rounded-md border bg-background px-2 font-mono text-xs outline-none",
              draftError ? "border-destructive" : "border-border",
            )}
          />
        </form>
      ) : (
        apps.length < maxApps && (
          <BarButton
            label={t("sandbox.appTabs.add")}
            onClick={() => setDraft("")}
          >
            <Plus />
          </BarButton>
        )
      )}
      {!isMobile && splitTarget && (
        <BarButton
          label={splitLabel}
          active={split}
          onClick={() =>
            setLayout(split ? SINGLE_MAIN : { app: splitTarget, split: true })
          }
        >
          <Columns02 />
        </BarButton>
      )}
    </>
  );

  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      <Panel.Topbar.Left.Portal
        fallback={
          <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
            {appBar}
          </div>
        }
      >
        <div className="ml-1 flex min-w-0 items-center gap-1 border-l border-border/60 pl-2">
          {appBar}
        </div>
      </Panel.Topbar.Left.Portal>
      <div className="flex min-h-0 flex-1">
        {showMain && (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
        )}
        {extra !== null && (
          <AppPane
            // A new app starts from its own root, not the last one's page.
            key={extra}
            name={appLabel(extra)}
            mainName={mainLabel}
            appUrl={mainUrl ? appPreviewUrl(mainUrl, extra) : null}
            ready={ready}
            failed={failed}
            notStarted={!localUrl && !startedApps.includes(extra)}
            onStart={lifecycle.start}
            className={cn(split && "border-l border-border")}
            onClose={
              split ? () => setLayout({ app: extra, split: false }) : undefined
            }
          />
        )}
      </div>
    </div>
  );
}

function AppTab({
  label,
  badge,
  hint,
  ready,
  failed,
  onScreen,
  onSelect,
  onRemove,
  removeLabel,
}: {
  label: string;
  badge?: string;
  /** What this app is wired to: the chat and editor, or only the preview. */
  hint: string;
  ready: boolean;
  failed: boolean;
  onScreen: boolean;
  onSelect: () => void;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  return (
    <div
      className={cn(
        "group/app-tab flex h-7 shrink-0 items-center rounded-md text-xs transition-colors",
        onScreen
          ? "bg-sidebar-accent text-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            role="tab"
            aria-selected={onScreen}
            onClick={onSelect}
            className="flex h-full items-center gap-1.5 rounded-md px-2.5 focus-ring"
          >
            <span
              aria-hidden
              className={cn(
                "size-1.5 rounded-full",
                ready
                  ? "bg-success"
                  : failed
                    ? "bg-destructive"
                    : "animate-pulse bg-warning",
              )}
            />
            <span className="max-w-40 truncate">{label}</span>
            {badge && (
              <span className="text-[10px] text-muted-foreground">{badge}</span>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">{hint}</TooltipContent>
      </Tooltip>
      {onRemove && (
        <button
          type="button"
          aria-label={removeLabel}
          onClick={onRemove}
          className="-ml-1 mr-1 flex size-5 items-center justify-center rounded opacity-0 hover:bg-sidebar-accent focus-ring focus-visible:opacity-100 group-hover/app-tab:opacity-100"
        >
          <XClose className="size-3" />
        </button>
      )}
    </div>
  );
}

function AppPane({
  name,
  mainName,
  appUrl,
  ready,
  failed,
  notStarted,
  onStart,
  className,
  onClose,
}: {
  name: string;
  mainName: string;
  appUrl: string | null;
  ready: boolean;
  failed: boolean;
  /** The sandbox runs, but was started without this app. */
  notStarted: boolean;
  onStart: () => void;
  className?: string;
  /** Present in split view: shows the main app alone again. */
  onClose?: () => void;
}) {
  const t = useT();
  const [pagePath, setPagePath] = useState("/");
  const [device, setDevice] = useState<PaneDevice>("desktop");
  const [reloadCount, setReloadCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const src = appUrl ? withPagePath(appUrl, pagePath) : null;

  return (
    <section
      aria-label={name}
      className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            setPagePath(inputRef.current?.value || "/");
          }}
        >
          <input
            ref={inputRef}
            defaultValue={pagePath}
            aria-label={t("sandbox.appPane.path", { app: name })}
            className="h-7 w-full rounded-md border border-border/60 bg-background px-2 font-mono text-xs text-muted-foreground outline-none hover:border-border focus:border-border focus:text-foreground"
          />
        </form>
        <BarButton
          label={
            device === "desktop"
              ? t("sandbox.preview.deviceMobile")
              : t("sandbox.preview.deviceDesktop")
          }
          onClick={() =>
            setDevice((d) => (d === "desktop" ? "mobile" : "desktop"))
          }
        >
          {device === "desktop" ? <Monitor04 /> : <Phone02 />}
        </BarButton>
        <BarButton
          label={t("sandbox.appPane.reload", { app: name })}
          disabled={!src || !ready}
          onClick={() => setReloadCount((n) => n + 1)}
        >
          <RefreshCw01 />
        </BarButton>
        <BarButton
          label={t("sandbox.appPane.openInNewTab", { app: name })}
          disabled={!src || !ready}
          onClick={() => src && window.open(src, "_blank", "noopener")}
        >
          <LinkExternal01 />
        </BarButton>
        {onClose && (
          <BarButton
            label={t("sandbox.appPane.close", { app: name })}
            onClick={onClose}
          >
            <XClose />
          </BarButton>
        )}
      </div>
      <p className="shrink-0 truncate border-b border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
        {t("sandbox.appPane.previewOnly", { app: mainName })}
      </p>
      <div className="flex min-h-0 flex-1 justify-center overflow-auto bg-muted/40">
        {ready && notStarted ? (
          <div className="flex flex-col items-center gap-3 self-center px-6 text-center">
            <p className="text-sm text-muted-foreground">
              {t("sandbox.appPane.notStarted", { app: name })}
            </p>
            <Button size="sm" variant="outline" onClick={onStart}>
              {t("sandbox.appPane.start", { app: name })}
            </Button>
          </div>
        ) : !ready || !src ? (
          <p className="self-center px-6 text-center text-sm text-muted-foreground">
            {ready
              ? t("sandbox.appPane.noUrl")
              : failed
                ? t("sandbox.appPane.failed", { app: mainName })
                : t("sandbox.appPane.waiting")}
          </p>
        ) : (
          // oxlint-disable-next-line react/iframe-missing-sandbox -- unsandboxed like the main preview frame (see its TODO)
          <iframe
            key={`${src}#${reloadCount}`}
            src={src}
            title={name}
            className={cn(
              "h-full bg-background",
              device === "mobile"
                ? "w-[412px] max-w-full border-x border-border"
                : "w-full",
            )}
          />
        )}
      </div>
    </section>
  );
}

function BarButton({
  label,
  children,
  active,
  disabled,
  onClick,
}: {
  label: string;
  children: ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <ToolbarIconButton
          aria-label={label}
          aria-pressed={active}
          active={active}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </ToolbarIconButton>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
