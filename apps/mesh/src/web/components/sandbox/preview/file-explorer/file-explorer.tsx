import { useState, useRef } from "react";
import Editor, { loader } from "@monaco-editor/react";
import type { OnMount } from "@monaco-editor/react";
import {
  ChevronDown,
  ChevronRight,
  File06,
  FolderClosed,
  Loading01,
  SearchSm,
  XClose,
} from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.js";
import { ScrollArea } from "@deco/ui/components/scroll-area.tsx";
import { useChatStream } from "@/web/components/chat/context";
import { usePanelActions } from "@/web/layouts/shell-layout";
import type { FileBuffer } from "./types";
import {
  buildFileTree,
  flattenTree,
  getAncestorDirectories,
  getLanguageFromPath,
  stripLineNumbers,
} from "./utils";

// Configure Monaco CDN (shared with workflow editor)
loader.config({
  paths: {
    vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs",
  },
});

interface FileExplorerProps {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}

function buildApiUrl(
  orgSlug: string,
  virtualMcpId: string,
  branch: string,
  endpoint: string,
) {
  return `/api/${orgSlug}/vm/${encodeURIComponent(virtualMcpId)}/${encodeURIComponent(branch)}/${endpoint}`;
}

/** The daemon expects relative paths (no leading slash). */
function toDaemonPath(treePath: string) {
  return treePath.startsWith("/") ? treePath.slice(1) : treePath;
}

export function FileExplorer({
  orgSlug,
  virtualMcpId,
  branch,
}: FileExplorerProps) {
  // File tree state
  const [files, setFiles] = useState<string[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [treeLoaded, setTreeLoaded] = useState(false);

  // File buffers: path -> { savedContent, editorValue, loaded }
  const [buffers, setBuffers] = useState<Map<string, FileBuffer>>(new Map());

  // Editor ref for save
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  // Ask AI inline prompt state
  const [askAi, setAskAi] = useState<{
    filePath: string;
    lineStart: number;
    lineEnd: number;
    selectedCode: string;
  } | null>(null);
  const { sendMessage } = useChatStream();
  const { setChatOpen } = usePanelActions();

  // Load file tree on first render
  const loadTreeCalledRef = useRef(false);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- one-shot fetch trigger
  if (!loadTreeCalledRef.current) {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- one-shot fetch trigger
    loadTreeCalledRef.current = true;
    fetchFileTree();
  }

  async function fetchFileTree() {
    setLoading(true);
    try {
      const res = await fetch(
        buildApiUrl(orgSlug, virtualMcpId, branch, "glob"),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pattern: "**/*" }),
        },
      );
      if (!res.ok) return;
      const data = (await res.json()) as { files?: string[] };
      setFiles(data.files ?? []);
      setTreeLoaded(true);
    } finally {
      setLoading(false);
    }
  }

  async function loadFileContent(path: string) {
    const existing = buffers.get(path);
    if (existing?.loaded) return;

    setBuffers((prev) => {
      const next = new Map(prev);
      next.set(path, { savedContent: "", editorValue: "", loaded: false });
      return next;
    });

    try {
      const res = await fetch(
        buildApiUrl(orgSlug, virtualMcpId, branch, "read"),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: toDaemonPath(path) }),
        },
      );
      if (!res.ok) return;
      const data = (await res.json()) as {
        kind?: string;
        content?: string;
      };
      const content = stripLineNumbers(data.content ?? "");
      setBuffers((prev) => {
        const next = new Map(prev);
        next.set(path, {
          savedContent: content,
          editorValue: content,
          loaded: true,
        });
        return next;
      });
    } catch {
      // Failed to load — leave buffer empty
    }
  }

  async function saveFile(path: string, content: string) {
    try {
      const res = await fetch(
        buildApiUrl(orgSlug, virtualMcpId, branch, "write"),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: toDaemonPath(path), content }),
        },
      );
      if (!res.ok) return;
      setBuffers((prev) => {
        const next = new Map(prev);
        const buf = next.get(path);
        if (buf) {
          next.set(path, { ...buf, savedContent: content });
        }
        return next;
      });
    } catch {
      // Save failed silently
    }
  }

  function openFile(path: string) {
    setSelectedFile(path);
    setAskAi(null);
    if (!openTabs.includes(path)) {
      setOpenTabs((prev) => [...prev, path]);
    }
    loadFileContent(path);
  }

  function closeTab(path: string) {
    setOpenTabs((prev) => {
      const next = prev.filter((t) => t !== path);
      if (selectedFile === path) {
        setSelectedFile(next[next.length - 1] ?? null);
      }
      return next;
    });
    setBuffers((prev) => {
      const next = new Map(prev);
      next.delete(path);
      return next;
    });
  }

  function toggleDir(path: string) {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  function handleFileClick(path: string) {
    // Auto-expand ancestor directories
    const ancestors = getAncestorDirectories(path);
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      for (const a of ancestors) next.add(a);
      return next;
    });
    openFile(path);
  }

  const tree = buildFileTree(files);
  const flatNodes = flattenTree(tree, expandedDirs);

  // Filter by search
  const filteredNodes = search
    ? flatNodes.filter((row) =>
        row.node.name.toLowerCase().includes(search.toLowerCase()),
      )
    : flatNodes;

  const currentBuffer = selectedFile ? buffers.get(selectedFile) : null;
  const isDirty =
    currentBuffer?.loaded &&
    currentBuffer.editorValue !== currentBuffer.savedContent;

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;

    // Ctrl+S / Cmd+S to save
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
      if (!selectedFile) return;
      const value = editor.getValue();
      await saveFile(selectedFile, value);
    });

    // Ctrl+K / Cmd+K to open "Ask the AI" prompt
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => {
      const selection = editor.getSelection();
      const model = editor.getModel();
      if (!selection || !model || !selectedFile) return;
      const selectedCode = model.getValueInRange(selection);
      setAskAi({
        filePath: selectedFile,
        lineStart: selection.startLineNumber,
        lineEnd: selection.endLineNumber,
        selectedCode,
      });
    });
  };

  function handleAskAiSend(prompt: string) {
    if (!askAi) return;
    const lines = [
      `The user selected code in the file explorer and asked: **"${prompt.trim()}"**`,
      "",
      `**File:** \`${askAi.filePath}\``,
      `**Lines:** ${askAi.lineStart}–${askAi.lineEnd}`,
    ];
    if (askAi.selectedCode) {
      const lang = getLanguageFromPath(askAi.filePath);
      const safeCode = askAi.selectedCode.replace(/```/g, "`` `");
      lines.push("", "**Selected code:**", "```" + lang, safeCode, "```");
    }
    lines.push(
      "",
      "Please read the source file, locate the code, and apply the requested change.",
    );
    setChatOpen(true);
    sendMessage({ parts: [{ type: "text", text: lines.join("\n") }] });
    setAskAi(null);
  }

  if (loading && !treeLoaded) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <Loading01 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* File tree sidebar */}
      <div className="w-64 shrink-0 border-r flex flex-col overflow-hidden">
        {/* Search */}
        <div className="p-2 border-b">
          <div className="relative">
            <SearchSm
              size={14}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search files..."
              className="w-full rounded-md border border-input bg-transparent pl-7 pr-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>

        {/* Tree */}
        <ScrollArea className="flex-1">
          <div className="py-1">
            {filteredNodes.map((row) => {
              const { node, depth } = row;
              const isDir = node.kind === "directory";
              const isExpanded = expandedDirs.has(node.path);
              const isSelected = selectedFile === node.path;

              return (
                <button
                  key={node.path}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-1 px-2 py-1 text-left text-xs hover:bg-accent transition-colors",
                    isSelected && "bg-accent",
                  )}
                  style={{ paddingLeft: `${depth * 12 + 8}px` }}
                  onClick={() => {
                    if (isDir) {
                      toggleDir(node.path);
                    } else {
                      handleFileClick(node.path);
                    }
                  }}
                >
                  {isDir ? (
                    <>
                      {isExpanded ? (
                        <ChevronDown
                          size={12}
                          className="shrink-0 text-muted-foreground"
                        />
                      ) : (
                        <ChevronRight
                          size={12}
                          className="shrink-0 text-muted-foreground"
                        />
                      )}
                      <FolderClosed
                        size={14}
                        className="shrink-0 text-muted-foreground"
                      />
                    </>
                  ) : (
                    <>
                      <span className="w-3 shrink-0" />
                      <File06
                        size={14}
                        className="shrink-0 text-muted-foreground"
                      />
                    </>
                  )}
                  <span className="truncate">{node.name}</span>
                </button>
              );
            })}
            {treeLoaded && filteredNodes.length === 0 && (
              <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                {search ? `No files match "${search}"` : "No files found"}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Editor area */}
      <div className="relative flex-1 flex flex-col overflow-hidden">
        {/* Tab bar */}
        {openTabs.length > 0 && (
          <div className="flex items-center border-b overflow-x-auto shrink-0">
            {openTabs.map((tab) => {
              const tabBuffer = buffers.get(tab);
              const tabDirty =
                tabBuffer?.loaded &&
                tabBuffer.editorValue !== tabBuffer.savedContent;
              const isActive = selectedFile === tab;
              const name = tab.split("/").pop() ?? tab;

              return (
                <div
                  key={tab}
                  className={cn(
                    "flex items-center gap-1 px-3 py-1.5 text-xs border-r cursor-pointer transition-colors",
                    isActive
                      ? "bg-background text-foreground"
                      : "bg-muted/50 text-muted-foreground hover:bg-accent",
                  )}
                  onClick={() => {
                    setSelectedFile(tab);
                    loadFileContent(tab);
                  }}
                  onKeyDown={() => {}}
                  role="tab"
                  tabIndex={0}
                  aria-selected={isActive}
                >
                  <span className="truncate max-w-32">{name}</span>
                  {tabDirty && (
                    <span className="w-1.5 h-1.5 rounded-full bg-foreground/60 shrink-0" />
                  )}
                  <button
                    type="button"
                    className="ml-1 rounded p-0.5 hover:bg-accent-foreground/10"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab);
                    }}
                  >
                    <XClose size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Ask AI inline prompt */}
        {askAi && (
          <div
            className="absolute top-0 left-1/2 -translate-x-1/2 z-20 mt-2"
            style={{ width: "360px" }}
          >
            <form
              className="flex w-full items-center gap-1.5 rounded-xl border border-border bg-background/95 px-3 py-1.5 shadow-lg backdrop-blur"
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const input = form.elements.namedItem(
                  "askAiInput",
                ) as HTMLInputElement;
                if (input.value.trim()) {
                  handleAskAiSend(input.value);
                }
              }}
            >
              <input
                name="askAiInput"
                autoFocus
                type="text"
                placeholder="Ask the AI..."
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Escape") setAskAi(null);
                }}
              />
              <button
                type="submit"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-opacity"
                title="Send"
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="none"
                  aria-hidden="true"
                >
                  <title>Send</title>
                  <path
                    d="M5 9V1M1 5l4-4 4 4"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </form>
          </div>
        )}

        {/* Monaco editor */}
        <div className="flex-1 overflow-hidden">
          {selectedFile && currentBuffer?.loaded ? (
            <Editor
              key={selectedFile}
              language={getLanguageFromPath(selectedFile)}
              theme={
                document.documentElement.classList.contains("dark")
                  ? "vs-dark"
                  : "light"
              }
              value={currentBuffer.editorValue}
              path={selectedFile}
              onChange={(value) => {
                const path = selectedFile;
                if (!path) return;
                setBuffers((prev) => {
                  const next = new Map(prev);
                  const buf = next.get(path);
                  if (buf) {
                    next.set(path, { ...buf, editorValue: value ?? "" });
                  }
                  return next;
                });
              }}
              onMount={handleEditorMount}
              loading={
                <div className="flex items-center justify-center h-full w-full">
                  <Loading01
                    size={20}
                    className="animate-spin text-muted-foreground"
                  />
                </div>
              }
              options={{
                fontSize: 13,
                scrollBeyondLastLine: false,
                automaticLayout: true,
                lineNumbersMinChars: 2,
                wordWrap: "on",
                minimap: { enabled: false },
                padding: { top: 12, bottom: 12 },
                scrollbar: {
                  vertical: "auto",
                  horizontal: "auto",
                  verticalScrollbarSize: 8,
                  horizontalScrollbarSize: 8,
                },
              }}
            />
          ) : selectedFile && !currentBuffer?.loaded ? (
            <div className="flex items-center justify-center h-full w-full">
              <Loading01
                size={20}
                className="animate-spin text-muted-foreground"
              />
            </div>
          ) : (
            <div className="flex items-center justify-center h-full w-full text-sm text-muted-foreground">
              Select a file to edit
            </div>
          )}
        </div>

        {/* Status bar */}
        {selectedFile && (
          <div className="flex items-center justify-between px-3 py-1 border-t text-[11px] text-muted-foreground shrink-0">
            <span className="truncate">{selectedFile}</span>
            <span>
              {isDirty ? "Modified" : "Saved"} &middot;{" "}
              {getLanguageFromPath(selectedFile)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
