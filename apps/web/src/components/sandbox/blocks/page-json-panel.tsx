import { isBlockBody } from "@/cms/block-body";
import { type Ref, useImperativeHandle, useState } from "react";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { X } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { MonacoCodeEditor } from "@/components/monaco-editor";
import { useProjectContext } from "@/sdk";
import { useChatTask } from "@/components/chat/context";
import { useSandboxLifecycle } from "@/components/sandbox/hooks/sandbox-lifecycle-context";
import {
  useDecofile,
  useEnsureDecofileBlocks,
} from "@/components/sections-editor/use-decofile";
import { useDebouncedSaveBlock } from "@/components/sections-editor/use-save-block";
import {
  copyScope,
  useCopyEpochs,
} from "@/components/sections-editor/held-copy";
import { usePackagePath } from "@/components/sections-editor/use-package-path";
import { decoBlockFilePath } from "@/components/sections-editor/deco-block-key";
import { decoRepoPath } from "@/components/sections-editor/deco-repo-path";
import { useNewBlocksEditorState } from "@/hooks/use-new-blocks-editor";
import { useT } from "@/i18n/use-t.ts";

/**
 * Editable Page JSON side panel. Renders alongside the CMS (Blocks) panel — same
 * width — instead of a modal, so the raw decofile entry can be edited in place
 * while the preview stays visible. Mirrors {@link BlocksPanel}'s data wiring
 * (decofile read + debounced block write): edits autosave once they settle, the
 * same way the section forms do — no explicit Save button. Invalid JSON mid-edit
 * is skipped silently until it parses again.
 */
export interface PageJsonPanelHandle {
  /** Persist any edit still inside the autosave debounce window. */
  flush: () => void;
}

export function PageJsonPanel({
  virtualMcpId,
  pageKey,
  onClose,
  ref,
}: {
  virtualMcpId: string;
  pageKey: string;
  /** Classic only: compact closes the panel from the preview toolbar toggle. */
  onClose: () => void;
  ref?: Ref<PageJsonPanelHandle>;
}) {
  const t = useT();
  const editorState = useNewBlocksEditorState();
  const compact = editorState === true;
  const packagePath = usePackagePath(virtualMcpId);
  const blockFilePath = decoRepoPath(packagePath, decoBlockFilePath(pageKey));
  const { org } = useProjectContext();
  const { currentBranch, taskId } = useChatTask();
  const lifecycle = useSandboxLifecycle();
  const previewUrl = lifecycle.previewUrl;

  const fetchParams = currentBranch
    ? {
        orgSlug: org.slug,
        virtualMcpId,
        branch: currentBranch,
        threadId: taskId ?? null,
        previewUrl,
      }
    : null;

  const decofile = useDecofile(fetchParams);
  const bodyLoad = useEnsureDecofileBlocks(fetchParams, [pageKey], {
    listing: decofile.data,
  });
  // The JSON is the editor's own copy: hosted saves are guarded by it, and
  // a reconcile seeds it again from the draft's copy.
  const { save, flush, hold } = useDebouncedSaveBlock(
    { orgSlug: org.slug, virtualMcpId, branch: currentBranch ?? "" },
    { holdsCopy: true },
  );
  const copyEpoch = useCopyEpochs(
    copyScope({
      orgSlug: org.slug,
      virtualMcpId,
      branch: currentBranch ?? "",
    }),
  )(pageKey);
  // Keep the JSON buffer through background reads, including invalid JSON.
  // Only another page or a reconciled copy replaces what the user is typing.
  const pageData = decofile.data?.[pageKey];
  const settled =
    bodyLoad.ready &&
    decofile.data !== undefined &&
    (pageData === undefined || isBlockBody(pageData));
  const [heldPage, setHeldPage] = useState({
    pageKey,
    copyEpoch,
    opened: false,
    code: "",
  });
  if (
    settled &&
    (heldPage.pageKey !== pageKey ||
      heldPage.copyEpoch !== copyEpoch ||
      !heldPage.opened)
  ) {
    setHeldPage({
      pageKey,
      copyEpoch,
      opened: true,
      code: pageData === undefined ? "" : JSON.stringify(pageData, null, 2),
    });
    if (isBlockBody(pageData)) hold(pageKey);
  }

  const showing = heldPage.pageKey === pageKey && heldPage.opened;
  const loading = editorState === undefined || (!showing && !settled);
  const missing = settled && pageData === undefined;
  const readOnly = !currentBranch || missing || loading;

  const scheduleSave = (raw: string) => {
    if (readOnly) return;
    setHeldPage((current) => ({ ...current, code: raw }));
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return;
    }
    save(pageKey, parsed as Record<string, unknown>);
  };

  // Parent close paths flush through this so a debounce-window edit still saves.
  useImperativeHandle(ref, () => ({ flush }));

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {compact ? (
        /* The file this pane writes, so it is obvious which block is open and
           where it lands in the repo. The toolbar toggle owns closing it. */
        <div className="flex shrink-0 items-center border-b px-3 py-2.5">
          <span
            title={blockFilePath}
            className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
          >
            {blockFilePath}
          </span>
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2.5">
          <div className="min-w-0 flex-1 truncate text-sm font-semibold">
            {t("sectionsEditor.pageJsonDialog.titleShort")}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label={t("sectionsEditor.pageJsonDialog.close")}
            className="shrink-0"
          >
            <X size={14} />
          </Button>
        </div>
      )}
      {!showing && bodyLoad.failed ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4">
          <p className="text-sm">
            {t("sectionsEditor.hosted.blockLoadFailed")}
          </p>
          <Button variant="outline" size="sm" onClick={bodyLoad.retry}>
            {t("sectionsEditor.namedRules.tryAgain")}
          </Button>
        </div>
      ) : loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="size-5 text-muted-foreground" />
        </div>
      ) : missing ? (
        <div className="p-4 text-xs font-mono text-foreground/60">
          {"// "}
          {t("sectionsEditor.pageJsonDialog.pageNotFound")}
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <MonacoCodeEditor
            key={`${heldPage.pageKey}:${heldPage.copyEpoch}`}
            code={heldPage.code}
            language="json"
            readOnly={readOnly}
            height="100%"
            onChange={(v) => scheduleSave(v ?? "")}
            onSave={(v) => {
              scheduleSave(v);
              flush();
            }}
          />
        </div>
      )}
    </div>
  );
}
