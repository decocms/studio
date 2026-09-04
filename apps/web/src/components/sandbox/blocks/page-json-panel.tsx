import { type Ref, useImperativeHandle, useState } from "react";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { X } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { MonacoCodeEditor } from "@/components/monaco-editor";
import { useProjectContext } from "@/sdk";
import { useChatTask } from "@/components/chat/context";
import { useSandboxLifecycle } from "@/components/sandbox/hooks/sandbox-lifecycle-context";
import { useDecofile } from "@/components/sections-editor/use-decofile";
import { useDebouncedSaveBlock } from "@/components/sections-editor/use-save-block";
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
  onClose: () => void;
  ref?: Ref<PageJsonPanelHandle>;
}) {
  const t = useT();
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
  const { save, flush } = useDebouncedSaveBlock({
    orgSlug: org.slug,
    virtualMcpId,
    branch: currentBranch ?? "",
  });

  const pageData = decofile.data?.[pageKey];
  const loading = decofile.data === undefined && decofile.isLoading;
  const missing = decofile.data !== undefined && pageData === undefined;
  const readOnly = !currentBranch || missing || loading;
  const initialJson =
    pageData === undefined ? "" : JSON.stringify(pageData, null, 2);

  /**
   * The panel can disappear without its Close button: choosing a global
   * component/loader removes the current page, and changing Site Editor tabs
   * unmounts Preview. Own the debounce at that lifecycle boundary so every
   * valid edit is persisted before useDebouncedSaveBlock cancels its timers.
   *
   * This callback ref is created once. React runs its returned cleanup only
   * when this mounted panel is actually detached (rather than on every render),
   * and the first `flush` closure is safe because the hook stores work in refs.
   */
  const [flushOnUnmount] = useState(() => (element: HTMLDivElement | null) => {
    if (!element) return;
    return () => flush();
  });

  const scheduleSave = (raw: string) => {
    if (readOnly) return;
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

  // Explicit close paths flush before changing focus; the lifecycle cleanup
  // above covers every other way this panel can disappear.
  useImperativeHandle(ref, () => ({ flush }));

  return (
    <div
      ref={flushOnUnmount}
      data-slot="page-json-panel"
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
    >
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2.5">
        <div className="min-w-0 flex-1 truncate text-sm font-semibold">
          {t("sectionsEditor.pageJsonDialog.titleShort")}
        </div>
        <Button
          autoFocus
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label={t("sectionsEditor.pageJsonDialog.close")}
          className="size-7 shrink-0"
        >
          <X size={14} />
        </Button>
      </div>
      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="size-5 text-muted-foreground" />
        </div>
      ) : missing ? (
        <div className="p-4 text-xs font-mono text-foreground/60">
          // {t("sectionsEditor.pageJsonDialog.pageNotFound")}
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <MonacoCodeEditor
            // Remount from the freshest snapshot once the decofile read lands.
            key={`${pageKey}:${decofile.data === undefined ? "loading" : "ready"}`}
            code={initialJson}
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
