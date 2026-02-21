import { useState, useSyncExternalStore } from "react";
import { useParams, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { usePluginContext } from "@decocms/mesh-sdk/plugins";
import { DECO_BLOCKS_BINDING } from "@decocms/bindings";
import { ChevronLeft } from "lucide-react";
import { Button } from "@deco/ui/components/button.tsx";
import { toast } from "sonner";
import { nanoid } from "nanoid";
import type {
  DecoBlocksBinding,
  BlockDefinition,
  LoaderDefinition,
} from "@decocms/bindings";
import {
  getPage,
  updatePage,
  type Page,
  type BlockInstance,
  type GenericToolCaller,
} from "../lib/page-api";
import { listBlocks } from "../lib/block-api";
import { useUndoRedo } from "../lib/use-undo-redo";
import { useIframeBridge } from "../lib/use-iframe-bridge";
import type { IframeMode } from "../lib/use-iframe-bridge";
import { QUERY_KEYS } from "../lib/query-keys";
import { SectionListSidebar } from "./section-list-sidebar";
import { PropEditor } from "./prop-editor";
import { PreviewPanel } from "./preview-panel";
import { BlockPicker } from "./block-picker";
import { LoaderDrawer } from "./loader-drawer";
import { FooterBar } from "./footer-bar";

// Module-level keyboard store to avoid recreating on every render
let _undoFn: (() => void) | null = null;
let _redoFn: (() => void) | null = null;
const kbListeners = new Set<() => void>();
let kbHandlerInstalled = false;

function installKeyboardHandler() {
  if (kbHandlerInstalled) return;
  kbHandlerInstalled = true;
  window.addEventListener("keydown", (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    if (e.key === "z" && !e.shiftKey) {
      e.preventDefault();
      _undoFn?.();
      for (const notify of kbListeners) notify();
    } else if ((e.key === "z" && e.shiftKey) || e.key === "y") {
      e.preventDefault();
      _redoFn?.();
      for (const notify of kbListeners) notify();
    }
  });
}

const kbStore = {
  subscribe: (notify: () => void) => {
    installKeyboardHandler();
    kbListeners.add(notify);
    return () => {
      kbListeners.delete(notify);
    };
  },
  getSnapshot: () => null as null,
  getServerSnapshot: () => null as null,
};

export default function PageComposer() {
  const { pageId, org, project } = useParams({ strict: false }) as {
    pageId: string;
    org: string;
    project: string;
  };
  const { toolCaller, connection } =
    usePluginContext<typeof DECO_BLOCKS_BINDING>();
  const typedCaller = toolCaller as unknown as
    | import("@decocms/bindings").TypedToolCaller<DecoBlocksBinding>
    | null;
  const genericCaller = toolCaller as unknown as GenericToolCaller;
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const projectId = connection?.id ?? "";
  const previewUrl =
    (connection?.metadata?.previewUrl as string | null | undefined) ?? null;

  // --- Page data ---
  const { data: page, isLoading } = useQuery({
    queryKey: QUERY_KEYS.page(projectId, pageId),
    queryFn: () => getPage(genericCaller, pageId),
    enabled: !!toolCaller && !!pageId,
  });

  // --- Block definitions ---
  const { data: allBlocks = [] } = useQuery({
    queryKey: QUERY_KEYS.blocks(projectId),
    queryFn: () => listBlocks(typedCaller!),
    enabled: !!typedCaller,
  });

  // --- Undo/redo for block list ---
  const {
    value: blocks,
    push: pushBlocks,
    undo,
    redo,
    canUndo,
    canRedo,
    reset,
  } = useUndoRedo<BlockInstance[]>(page?.blocks ?? []);

  // Reset undo history when page loads for the first time or changes
  // Ref-based change detection avoids useEffect
  const resetTrackerRef = { current: "" as string };
  if (page && resetTrackerRef.current !== pageId) {
    resetTrackerRef.current = pageId;
    reset(page.blocks);
  }

  // Wire undo/redo to module-level fns for keyboard handler
  _undoFn = undo;
  _redoFn = redo;

  // Subscribe to keyboard events via useSyncExternalStore (no useEffect)
  useSyncExternalStore(
    kbStore.subscribe,
    kbStore.getSnapshot,
    kbStore.getServerSnapshot,
  );

  // --- Local UI state ---
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [mode, setMode] = useState<IframeMode>("edit");
  const [blockPickerOpen, setBlockPickerOpen] = useState(false);
  const [loaderDrawerOpen, setLoaderDrawerOpen] = useState(false);
  const [loaderTargetProp, setLoaderTargetProp] = useState<string>("");

  // --- iframe bridge ---
  const bridge = useIframeBridge({
    page: page ? { ...page, blocks } : null,
    selectedBlockId,
    mode,
    onBlockClicked: (id) =>
      setSelectedBlockId((prev) => (prev === id ? null : id)),
    onClickAway: () => setSelectedBlockId(null),
  });

  // --- Save mutation ---
  const saveMutation = useMutation({
    mutationFn: async (updatedPage: Page) => {
      await updatePage(genericCaller, updatedPage);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: QUERY_KEYS.page(projectId, pageId),
      });
    },
    onError: () => toast.error("Failed to save"),
  });

  const saveBlocks = (newBlocks: BlockInstance[]) => {
    if (!page) return;
    pushBlocks(newBlocks);
    saveMutation.mutate({ ...page, blocks: newBlocks });
  };

  // --- Section operations ---
  const handleAddBlock = (blockDef: BlockDefinition) => {
    const newBlock: BlockInstance = {
      id: nanoid(8),
      blockType: blockDef.name,
      props: {},
    };
    saveBlocks([...blocks, newBlock]);
  };

  const handleReorder = (reordered: BlockInstance[]) => {
    saveBlocks(reordered);
  };

  const handleRemove = (id: string) => {
    saveBlocks(blocks.filter((b) => b.id !== id));
    if (selectedBlockId === id) setSelectedBlockId(null);
  };

  const handlePropsChange = (props: Record<string, unknown>) => {
    if (!selectedBlockId) return;
    saveBlocks(
      blocks.map((b) => (b.id === selectedBlockId ? { ...b, props } : b)),
    );
  };

  const handleLoaderBind = (loader: LoaderDefinition, prop: string) => {
    if (!selectedBlockId) return;
    saveBlocks(
      blocks.map((b) =>
        b.id === selectedBlockId
          ? {
              ...b,
              loaderBinding: {
                prop,
                loaderName: loader.name,
                loaderProps: {},
              },
            }
          : b,
      ),
    );
  };

  // Selected block and its definition
  const selectedBlock = selectedBlockId
    ? blocks.find((b) => b.id === selectedBlockId)
    : null;
  const selectedBlockDef = selectedBlock
    ? allBlocks.find((b) => b.name === selectedBlock.blockType)
    : undefined;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="text-sm text-muted-foreground">Loading page...</span>
      </div>
    );
  }

  if (!page) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="text-sm text-muted-foreground">Page not found</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Composer header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() =>
            navigate({
              to: "/$org/$project/$pluginId",
              params: { org, project, pluginId: "site-editor" },
            })
          }
        >
          <ChevronLeft size={14} />
        </Button>
        <span className="text-sm font-medium">{page.title}</span>
        <span className="text-xs text-muted-foreground">{page.path}</span>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs"
          disabled={!canUndo}
          onClick={undo}
        >
          Undo
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs"
          disabled={!canRedo}
          onClick={redo}
        >
          Redo
        </Button>
      </div>

      {/* Main composer area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left panel — section list OR prop editor (slide navigation) */}
        <div className="w-64 border-r relative overflow-hidden flex-shrink-0">
          {/* Section list panel */}
          <div
            className={`absolute inset-0 transition-transform duration-200 ${
              selectedBlock ? "-translate-x-full" : "translate-x-0"
            }`}
          >
            <SectionListSidebar
              blocks={blocks}
              selectedBlockId={selectedBlockId}
              onSelectBlock={(id) => setSelectedBlockId(id)}
              onReorder={handleReorder}
              onRemove={handleRemove}
              onAddSection={() => setBlockPickerOpen(true)}
            />
          </div>

          {/* Prop editor panel */}
          <div
            className={`absolute inset-0 transition-transform duration-200 ${
              selectedBlock ? "translate-x-0" : "translate-x-full"
            }`}
          >
            {selectedBlock && (
              <PropEditor
                block={selectedBlock}
                blockDef={selectedBlockDef}
                onPropsChange={handlePropsChange}
                onBack={() => setSelectedBlockId(null)}
                onBindLoader={(prop) => {
                  setLoaderTargetProp(prop);
                  setLoaderDrawerOpen(true);
                }}
              />
            )}
          </div>

          {/* Loader drawer (absolute overlay on left panel) */}
          {typedCaller && (
            <LoaderDrawer
              open={loaderDrawerOpen}
              onClose={() => setLoaderDrawerOpen(false)}
              onSelect={handleLoaderBind}
              toolCaller={typedCaller}
              projectId={projectId}
              targetProp={loaderTargetProp}
            />
          )}
        </div>

        {/* Right panel — preview iframe */}
        <div className="flex-1 relative overflow-hidden">
          <PreviewPanel
            previewUrl={previewUrl}
            mode={mode}
            onModeChange={setMode}
            bridge={bridge}
          />
        </div>
      </div>

      {/* Git footer — hidden if no bash tool */}
      <FooterBar
        pageId={pageId}
        projectId={projectId}
        toolCaller={genericCaller}
        connectionTools={connection?.tools}
        onPageReverted={() => {
          queryClient.invalidateQueries({
            queryKey: QUERY_KEYS.page(projectId, pageId),
          });
        }}
      />

      {/* Block picker modal */}
      {typedCaller && (
        <BlockPicker
          open={blockPickerOpen}
          onClose={() => setBlockPickerOpen(false)}
          onSelect={handleAddBlock}
          toolCaller={typedCaller}
          projectId={projectId}
        />
      )}
    </div>
  );
}
