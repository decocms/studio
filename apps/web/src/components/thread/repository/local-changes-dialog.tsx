/**
 * Localhost's changes: what the site editor saved to the site's files since
 * the last commit, over the content protocol (`changes.list`/`get`/`discard`
 * on the connected `deco serve`), with the same cards, Code tab and discards
 * as the publish dialog. There is no Publish here: the developer commits and
 * pushes with git. The header shows a "Changes" button while connected.
 */

import { Button, buttonVariants } from "@decocms/ui/components/button.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { CheckCircle } from "@untitledui/icons";
import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { Suspense, useState } from "react";
import { ErrorBoundary } from "@/components/error-boundary.tsx";
import { useT } from "@/i18n/use-t.ts";
import type { ProtocolBackend } from "@/components/sections-editor/content-backend.ts";
import { useContentChanges } from "@/components/sections-editor/content-changes.ts";
import { useContentSyncState } from "@/components/sections-editor/content-sync.ts";
import { RichCode } from "@/components/sections-editor/deco-serve-notices.tsx";
import { useContentBackend } from "@/components/sections-editor/use-content-backend.ts";
import { useDecofileCacheKey } from "@/components/sections-editor/use-decofile.ts";
import { changeId, PublishChangeCard } from "./cms-publish-change-card.tsx";
import { PublishCompare } from "./cms-publish-compare.tsx";
import {
  PublishFrame,
  PublishGhostCard,
  PublishListRegion,
} from "./cms-publish-frame.tsx";
import {
  REVIEW_PANE,
  ReviewLayout,
  ReviewPaneGhost,
} from "./publish-dialog.tsx";
import { useContentDiscard } from "./use-cms-publish-actions.ts";
import { useContentPublishState } from "./use-content-publish-state.ts";

/** The header's "Changes" button on Localhost, and the dialog it opens. */
export function LocalChangesButton({
  orgSlug,
  virtualMcpId,
  branch,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string | null;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const backend = useContentBackend(virtualMcpId, branch);
  const local =
    backend.kind === "protocol" && backend.source === "local" ? backend : null;
  const cacheKey = useDecofileCacheKey(
    branch ? { orgSlug, virtualMcpId, branch } : null,
  );
  const { data } = useContentChanges(local, cacheKey);
  if (!local || !cacheKey || !branch) return null;
  const count = data ? Object.keys(data.changes).length : 0;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        data-testid="local-changes-button"
        onClick={() => setOpen(true)}
      >
        {count > 0
          ? t("decoServe.changes.buttonCount", { count })
          : t("decoServe.changes.button")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          aria-describedby={undefined}
          className="flex h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-none flex-col md:flex-row md:h-[calc(100dvh-6rem)] md:w-[calc(100vw-6rem)] gap-0 overflow-hidden p-0 sm:max-w-none"
          closeButtonClassName="top-3.5 right-3.5"
        >
          <DialogTitle className="sr-only">
            {t("decoServe.changes.title")}
          </DialogTitle>
          {open ? (
            <QueryErrorResetBoundary>
              {({ reset }) => (
                <ErrorBoundary
                  fallback={({ resetError }) => (
                    <LocalChangesFrame
                      title={t("decoServe.changes.title")}
                      body={
                        <p className="px-4 py-6 text-xs text-muted-foreground">
                          {t("decoServe.changes.loadFailed")}
                        </p>
                      }
                      onClose={() => {
                        reset();
                        resetError();
                        setOpen(false);
                      }}
                    />
                  )}
                >
                  <Suspense
                    fallback={
                      <ReviewLayout
                        pane={<ReviewPaneGhost />}
                        list={
                          <LocalChangesFrame
                            title={t("decoServe.changes.title")}
                            loading
                            body={
                              <PublishListRegion>
                                <div className="space-y-1.5">
                                  <PublishGhostCard />
                                  <PublishGhostCard />
                                </div>
                              </PublishListRegion>
                            }
                            onClose={() => setOpen(false)}
                          />
                        }
                      />
                    }
                  >
                    <LocalChangesContent
                      orgSlug={orgSlug}
                      virtualMcpId={virtualMcpId}
                      branch={branch}
                      backend={local}
                      cacheKey={cacheKey}
                      onClose={() => setOpen(false)}
                    />
                  </Suspense>
                </ErrorBoundary>
              )}
            </QueryErrorResetBoundary>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function LocalChangesFrame({
  title,
  trailing,
  body,
  loading = false,
  onClose,
}: {
  title: string;
  trailing?: React.ReactNode;
  body: React.ReactNode;
  loading?: boolean;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <PublishFrame
      state={loading ? "loading" : "ready"}
      header={
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="truncate">{title}</span>
          {trailing}
        </div>
      }
      body={body}
      footer={
        <>
          <p className="text-2xs text-muted-foreground">
            <RichCode text={t("decoServe.changes.hint")} />
          </p>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={onClose}
          >
            {t("decoServe.changes.close")}
          </Button>
        </>
      }
    />
  );
}

function LocalChangesContent({
  orgSlug,
  virtualMcpId,
  branch,
  backend,
  cacheKey,
  onClose,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  backend: ProtocolBackend;
  cacheKey: string;
  onClose: () => void;
}) {
  const t = useT();
  const state = useContentPublishState({ backend, cacheKey });
  const discard = useContentDiscard({
    orgSlug,
    virtualMcpId,
    branch,
    refresh: state.refresh,
  });
  const isDiscarding =
    useContentSyncState(orgSlug, virtualMcpId).phase === "saving";
  const readOnly = backend.describe.readOnly;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [discardAllConfirm, setDiscardAllConfirm] = useState(false);

  const { summary } = state;
  const changes = [...summary.pages, ...summary.blocks];
  const selected =
    changes.find((change) => changeId(change) === activeId) ??
    changes[0] ??
    null;

  const title =
    summary.count === 0
      ? t("decoServe.changes.title")
      : summary.count === 1
        ? t("decoServe.changes.titleOne")
        : t("decoServe.changes.titleCount", { count: summary.count });

  const renderGroup = (label: string, group: typeof changes) =>
    group.length === 0 ? null : (
      <div className="space-y-1.5">
        <div className="px-0.5 text-2xs font-medium text-muted-foreground">
          {label}
        </div>
        {group.map((change) => {
          const id = changeId(change);
          return (
            <PublishChangeCard
              key={id}
              change={change}
              bodyPending={state.sidesPending}
              selected={selected !== null && changeId(selected) === id}
              onSelect={() => setActiveId(id)}
              confirming={confirmingId === id}
              onConfirmingChange={(confirming) =>
                setConfirmingId(confirming ? id : null)
              }
              onDiscard={
                readOnly || !change.entry
                  ? undefined
                  : () =>
                      void discard(
                        backend,
                        [change.entry!],
                        t("thread.publishPopover.discarded", {
                          name: change.name,
                        }),
                      )
              }
              isPublishing={false}
              isDiscarding={isDiscarding}
            />
          );
        })}
      </div>
    );

  const discardAll =
    readOnly || summary.count <= 1 ? null : (
      <>
        <button
          type="button"
          className="ml-auto shrink-0 text-2xs text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
          onClick={() => setDiscardAllConfirm(true)}
          disabled={isDiscarding}
        >
          {t("thread.publishPopover.discardAll")}
        </button>
        <AlertDialog
          open={discardAllConfirm}
          onOpenChange={setDiscardAllConfirm}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("thread.publishPopover.discardAllTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("thread.publishPopover.discardAllConfirm")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                {t("thread.publishDialog.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  void discard(
                    backend,
                    state.entries,
                    t("thread.publishDialog.allChangesDiscarded"),
                  )
                }
                disabled={isDiscarding}
                className={cn(buttonVariants({ variant: "destructive" }))}
              >
                {t("thread.publishPopover.discardAll")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );

  const body =
    summary.count === 0 ? (
      <div className="flex flex-col items-center gap-1 py-10 text-center">
        <CheckCircle className="mb-1 size-5 text-success" />
        <p className="text-sm font-medium">{t("decoServe.changes.empty")}</p>
      </div>
    ) : (
      <PublishListRegion>
        {renderGroup(t("thread.publishPopover.pagesGroup"), summary.pages)}
        {renderGroup(t("thread.publishPopover.blocksGroup"), summary.blocks)}
        {state.sidesFailed ? (
          <p className="text-2xs text-muted-foreground">
            {t("thread.publishPopover.detailsUnavailable")}
          </p>
        ) : null}
      </PublishListRegion>
    );

  return (
    <ReviewLayout
      pane={
        selected ? (
          <div className={cn(REVIEW_PANE, "relative flex")}>
            <PublishCompare
              key={changeId(selected)}
              change={selected}
              diff={null}
              bodyPending={state.sidesPending}
              previewServerUrl={null}
              draft={null}
              lastPage={null}
              v8={{ blocks: state.blocks }}
            />
          </div>
        ) : (
          <div className={cn(REVIEW_PANE, "bg-muted/40")} />
        )
      }
      list={
        <LocalChangesFrame
          title={title}
          trailing={discardAll}
          body={body}
          onClose={onClose}
        />
      }
    />
  );
}
