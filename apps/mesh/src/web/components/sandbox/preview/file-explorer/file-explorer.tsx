import { useQueryClient } from "@tanstack/react-query";
import { useState, useRef } from "react";
import Editor, { loader } from "@monaco-editor/react";
import type { OnMount } from "@monaco-editor/react";
import {
  Brackets,
  File02,
  FileCode01,
  FilePlus01,
  FolderPlus,
  Image01,
  Loading01,
  SearchSm,
  XClose,
} from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.js";
import { Button } from "@deco/ui/components/button.tsx";
import { ScrollArea } from "@deco/ui/components/scroll-area.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@deco/ui/components/alert-dialog.tsx";
import { toast } from "sonner";
import { useChatStream } from "@/web/components/chat/context";
import { usePanelActions } from "@/web/layouts/shell-layout";
import { KEYS } from "@/web/lib/query-keys";
import { saveChangesDebug } from "../../../thread/github/save-changes-debug.ts";
import {
  fetchGitStatus,
  sandboxGitStatusQueryKey,
} from "../../../thread/github/sandbox-git-api.ts";
import type { FileBuffer, TreeNode } from "./types";
import {
  FileExplorerNameDialog,
  type FileExplorerNameDialogMode,
} from "./file-explorer-name-dialog";
import { FileTreeRow } from "./file-tree-row";
import {
  buildFileTree,
  decoBlockKeyFromTreePath,
  directoryNeedsLazyLoad,
  EXPLORER_EAGER_DEPTH,
  EXPLORER_GLOB_LIMIT,
  flattenTree,
  getAncestorDirectories,
  getDirectoryContextPath,
  getLanguageFromPath,
  getParentTreePath,
  joinTreePath,
  mergeGlobLists,
  pathExistsInFileList,
  stripLineNumbers,
  toDaemonPath,
  toTreePath,
  validateExplorerEntryName,
  type GlobListResult,
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
  /**
   * When set (or changed), opens this file path in the editor — expanding
   * ancestor folders, selecting it, and loading its content. Used to deep-link
   * into a file (e.g. "View JSON" opening a page's `.deco/blocks/<key>.json`).
   */
  openPath?: string | null;
}

function buildApiUrl(
  orgSlug: string,
  virtualMcpId: string,
  branch: string,
  endpoint: string,
) {
  return `/api/${orgSlug}/sandbox/${encodeURIComponent(virtualMcpId)}/${encodeURIComponent(branch)}/${endpoint}`;
}

/** Reject path traversal and absolute paths outside the workspace root. */
function isSafeExplorerOpenPath(path: string): boolean {
  const normalized = toDaemonPath(path);
  if (!normalized || normalized.includes("..") || normalized.includes("\\")) {
    return false;
  }
  return (
    normalized.startsWith(".deco/blocks/") ||
    (!normalized.startsWith("/") && !normalized.includes("://"))
  );
}

type FileIcon = React.ComponentType<{
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}>;

/** Warm folder tone — reads well on both light and dark backgrounds. */
const DEFAULT_FILE_COLOR = "#94a3b8";

/**
 * Maps a filename to an icon + accent color by extension, so the tree reads at
 * a glance (blue for TS, amber for JSON, purple for images, …). Colors are
 * inline (not Tailwind scale tokens) and chosen to work in light and dark.
 */
function getFileVisual(name: string): { Icon: FileIcon; color: string } {
  const n = name.toLowerCase();
  if (n.endsWith(".tsx") || n.endsWith(".ts"))
    return { Icon: FileCode01, color: "#3b82f6" };
  if (
    n.endsWith(".jsx") ||
    n.endsWith(".js") ||
    n.endsWith(".mjs") ||
    n.endsWith(".cjs")
  )
    return { Icon: FileCode01, color: "#d9a441" };
  if (n.endsWith(".json")) return { Icon: Brackets, color: "#cb9b3f" };
  if (n.endsWith(".css") || n.endsWith(".scss"))
    return { Icon: FileCode01, color: "#06b6d4" };
  if (n.endsWith(".html") || n.endsWith(".xml"))
    return { Icon: FileCode01, color: "#f97316" };
  if (/\.(png|jpe?g|gif|webp|avif|ico|svg)$/.test(n))
    return { Icon: Image01, color: "#a855f7" };
  if (n.endsWith(".md") || n.endsWith(".mdx"))
    return { Icon: File02, color: "#64748b" };
  return { Icon: File02, color: DEFAULT_FILE_COLOR };
}

export function FileExplorer({
  orgSlug,
  virtualMcpId,
  branch,
  openPath,
}: FileExplorerProps) {
  // File tree state
  const [files, setFiles] = useState<string[]>([]);
  const [directories, setDirectories] = useState<string[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedTreeNode, setSelectedTreeNode] = useState<TreeNode | null>(
    null,
  );
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [treeLoaded, setTreeLoaded] = useState(false);
  const [loadedLazyDirs, setLoadedLazyDirs] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());

  const treeGenerationRef = useRef(0);
  const initialTreeLoadRef = useRef<Promise<void> | null>(null);
  const filesRef = useRef<string[]>([]);
  const directoriesRef = useRef<string[]>([]);
  const loadedLazyDirsRef = useRef<Set<string>>(new Set());
  const lazyLoadInflightRef = useRef<Map<string, Promise<boolean>>>(new Map());
  const treeTruncatedRef = useRef(false);

  filesRef.current = files;
  directoriesRef.current = directories;
  loadedLazyDirsRef.current = loadedLazyDirs;

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
  const queryClient = useQueryClient();

  const [nameDialog, setNameDialog] = useState<{
    mode: FileExplorerNameDialogMode;
    node: TreeNode;
    parentDir: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TreeNode | null>(null);
  const [fsActionPending, setFsActionPending] = useState(false);

  async function postSandbox(endpoint: string, body: Record<string, unknown>) {
    const res = await fetch(
      buildApiUrl(orgSlug, virtualMcpId, branch, endpoint),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(
        (payload as { error?: string }).error ??
          `Request failed (${res.status})`,
      );
    }
    return res.json();
  }

  async function refreshGitStatus() {
    void queryClient.invalidateQueries({
      queryKey: sandboxGitStatusQueryKey(orgSlug, virtualMcpId, branch),
    });
  }

  function copyText(label: string, value: string) {
    void navigator.clipboard.writeText(value).then(
      () => toast.success(`${label} copied`),
      () => toast.error(`Failed to copy ${label.toLowerCase()}`),
    );
  }

  function invalidateDecofileCacheForDeletedPath(treePath: string) {
    const blockKey = decoBlockKeyFromTreePath(treePath);
    if (!blockKey) return;
    const cacheKey = `${orgSlug}/${virtualMcpId}/${branch}`;
    queryClient.setQueryData(
      KEYS.decofile(cacheKey),
      (current: Record<string, unknown> | undefined) => {
        if (!current) return current;
        const { [blockKey]: _removed, ...rest } = current;
        return rest;
      },
    );
    void queryClient.invalidateQueries({ queryKey: KEYS.liveMeta(cacheKey) });
  }

  function invalidateDecofileCachesForDeletedNode(node: TreeNode) {
    const pathsToInvalidate =
      node.kind === "file"
        ? [node.path]
        : files
            .filter((file) => file.startsWith(".deco/blocks/"))
            .map((file) => toTreePath(file))
            .filter(
              (path) => path === node.path || path.startsWith(`${node.path}/`),
            );
    for (const path of pathsToInvalidate) {
      invalidateDecofileCacheForDeletedPath(path);
    }
  }

  function getDirtyOpenPathsUnder(prefix: string): string[] {
    const normalizedPrefix = toTreePath(prefix);
    return openTabs.filter((tab) => {
      if (tab !== normalizedPrefix && !tab.startsWith(`${normalizedPrefix}/`)) {
        return false;
      }
      const buf = buffers.get(tab);
      return Boolean(buf?.loaded && buf.editorValue !== buf.savedContent);
    });
  }

  function remapOpenPaths(remap: (path: string) => string | null) {
    setOpenTabs((prev) =>
      prev
        .map((tab) => remap(tab))
        .filter((tab): tab is string => tab !== null),
    );
    setSelectedFile((prev) => {
      if (!prev) return prev;
      const next = remap(prev);
      return next;
    });
    setBuffers((prev) => {
      const next = new Map<string, FileBuffer>();
      for (const [path, buffer] of prev) {
        const mapped = remap(path);
        if (mapped) next.set(mapped, buffer);
      }
      return next;
    });
    setSelectedTreeNode((prev) => {
      if (!prev) return prev;
      const nextPath = remap(prev.path);
      if (!nextPath) return null;
      if (nextPath === prev.path) return prev;
      return {
        ...prev,
        path: nextPath,
        name: nextPath.split("/").pop() ?? nextPath,
      };
    });
  }

  function removeOpenPaths(prefix: string) {
    const normalizedPrefix = toTreePath(prefix);
    setSelectedTreeNode((prev) => {
      if (!prev) return prev;
      if (
        prev.path === normalizedPrefix ||
        prev.path.startsWith(`${normalizedPrefix}/`)
      ) {
        return null;
      }
      return prev;
    });
    remapOpenPaths((path) => {
      if (
        path === normalizedPrefix ||
        path.startsWith(`${normalizedPrefix}/`)
      ) {
        return null;
      }
      return path;
    });
  }

  async function handleCreateFile(name: string) {
    if (!nameDialog) return;
    const filePath = joinTreePath(nameDialog.parentDir, name);
    if (pathExistsInFileList(filePath, files, directories)) {
      throw new Error(`"${name}" already exists`);
    }
    await postSandbox("write", {
      path: toDaemonPath(filePath),
      content: "",
    });
    await fetchFileTree();
    await refreshGitStatus();
    setNameDialog(null);
    handleFileClick(filePath);
  }

  async function handleCreateFolder(name: string) {
    if (!nameDialog) return;
    const folderPath = joinTreePath(nameDialog.parentDir, name);
    if (pathExistsInFileList(folderPath, files, directories)) {
      throw new Error(`"${name}" already exists`);
    }
    const daemonFolderPath = toDaemonPath(folderPath);
    await postSandbox("mkdir", { path: daemonFolderPath });
    setDirectories((prev) =>
      prev.includes(daemonFolderPath) ? prev : [...prev, daemonFolderPath],
    );
    await fetchFileTree();
    await refreshGitStatus();
    setNameDialog(null);
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      for (const dir of getAncestorDirectories(folderPath)) next.add(dir);
      next.add(folderPath);
      return next;
    });
    setSelectedTreeNode({
      name,
      path: folderPath,
      kind: "directory",
      children: [],
    });
  }

  async function handleRename(name: string) {
    if (!nameDialog) return;
    const fromPath = nameDialog.node.path;
    const parentDir = getParentTreePath(fromPath);
    const toPath = joinTreePath(parentDir, name);
    if (toPath === fromPath) {
      setNameDialog(null);
      return;
    }
    if (pathExistsInFileList(toPath, files, directories)) {
      throw new Error(`"${name}" already exists`);
    }
    await postSandbox("rename", {
      from: toDaemonPath(fromPath),
      to: toDaemonPath(toPath),
    });
    remapOpenPaths((path) => {
      if (path === fromPath) return toPath;
      if (path.startsWith(`${fromPath}/`)) {
        return joinTreePath(toPath, path.slice(fromPath.length + 1));
      }
      return path;
    });
    await fetchFileTree();
    await refreshGitStatus();
    setNameDialog(null);
  }

  async function handleDelete(node: TreeNode) {
    setFsActionPending(true);
    try {
      await postSandbox("unlink", {
        path: toDaemonPath(node.path),
        recursive: node.kind === "directory",
      });
      invalidateDecofileCachesForDeletedNode(node);
      removeOpenPaths(node.path);
      await fetchFileTree();
      await refreshGitStatus();
      setDeleteTarget(null);
      toast.success(`Deleted "${node.name}"`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setFsActionPending(false);
    }
  }

  async function handleNameDialogSubmit(name: string) {
    const validationError = validateExplorerEntryName(name);
    if (validationError) {
      toast.error(validationError);
      return;
    }
    setFsActionPending(true);
    try {
      if (nameDialog?.mode === "new-file") {
        await handleCreateFile(name);
        toast.success(`Created "${name}"`);
      } else if (nameDialog?.mode === "new-folder") {
        await handleCreateFolder(name);
        toast.success(`Created folder "${name}"`);
      } else if (nameDialog?.mode === "rename") {
        await handleRename(name);
        toast.success(`Renamed to "${name}"`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Operation failed");
    } finally {
      setFsActionPending(false);
    }
  }

  // Load file tree on first render
  const loadTreeCalledRef = useRef(false);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- one-shot fetch trigger
  if (!loadTreeCalledRef.current) {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- one-shot fetch trigger
    loadTreeCalledRef.current = true;
    initialTreeLoadRef.current = fetchFileTree();
  }

  // Deep-link: open the requested file when `openPath` is set or changes.
  const [prevOpenPath, setPrevOpenPath] = useState<string | null>(null);
  if (openPath && openPath !== prevOpenPath) {
    setPrevOpenPath(openPath);
    const pathToOpen = openPath;
    queueMicrotask(() => {
      if (isSafeExplorerOpenPath(pathToOpen)) {
        void handleFileClick(pathToOpen).catch((err) => {
          toast.error(
            err instanceof Error ? err.message : "Failed to open file",
          );
        });
      }
    });
  }

  async function fetchGlob(
    body: Record<string, unknown>,
  ): Promise<GlobListResult> {
    const data = (await postSandbox("glob", body)) as GlobListResult & {
      error?: string;
    };
    return {
      files: data.files ?? [],
      directories: data.directories ?? [],
      truncated: data.truncated,
    };
  }

  function applyGlobResult(
    result: GlobListResult,
    merge: boolean,
    generation: number,
  ): boolean {
    if (generation !== treeGenerationRef.current) return false;

    if (merge) {
      const merged = mergeGlobLists(
        filesRef.current,
        directoriesRef.current,
        result,
        treeTruncatedRef.current,
      );
      filesRef.current = merged.files;
      directoriesRef.current = merged.directories;
      treeTruncatedRef.current = Boolean(merged.truncated);
      setFiles(merged.files);
      setDirectories(merged.directories);
      if (merged.truncated) {
        toast.warning("File list truncated — some files may be hidden");
      }
      return Boolean(merged.truncated);
    }

    filesRef.current = result.files;
    directoriesRef.current = result.directories ?? [];
    treeTruncatedRef.current = Boolean(result.truncated);
    setFiles(result.files);
    setDirectories(result.directories ?? []);
    if (result.truncated) {
      toast.warning("File list truncated — some files may be hidden");
    }
    return Boolean(result.truncated);
  }

  async function fetchDirChildren(dirPath: string): Promise<boolean> {
    const inflight = lazyLoadInflightRef.current.get(dirPath);
    if (inflight) return inflight;

    const generation = treeGenerationRef.current;
    const promise = (async () => {
      const result = await fetchGlob({
        pattern: "**/*",
        path: toDaemonPath(dirPath),
        limit: EXPLORER_GLOB_LIMIT,
      });
      const truncated = applyGlobResult(result, true, generation);
      if (!truncated && generation === treeGenerationRef.current) {
        setLoadedLazyDirs((prev) => {
          const next = new Set(prev);
          next.add(dirPath);
          return next;
        });
      }
      return truncated;
    })();

    lazyLoadInflightRef.current.set(dirPath, promise);
    try {
      return await promise;
    } finally {
      lazyLoadInflightRef.current.delete(dirPath);
    }
  }

  async function loadLazyDirectory(dirPath: string): Promise<boolean> {
    if (!directoryNeedsLazyLoad(dirPath, loadedLazyDirsRef.current)) {
      return false;
    }
    setLoadingDirs((prev) => new Set(prev).add(dirPath));
    try {
      return await fetchDirChildren(dirPath);
    } finally {
      setLoadingDirs((prev) => {
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
    }
  }

  async function ensureAncestorsLoaded(treePath: string) {
    const loaded = new Set(loadedLazyDirsRef.current);
    for (const dir of getAncestorDirectories(treePath)) {
      if (!directoryNeedsLazyLoad(dir, loaded)) continue;
      const truncated = await loadLazyDirectory(dir);
      if (truncated) {
        throw new Error("Folder listing truncated — expand again to load more");
      }
      loaded.add(dir);
    }
  }

  async function fetchFileTree() {
    const generation = ++treeGenerationRef.current;
    lazyLoadInflightRef.current.clear();
    treeTruncatedRef.current = false;
    setLoading(true);
    setLoadedLazyDirs(new Set());
    setExpandedDirs(new Set());
    setLoadingDirs(new Set());
    try {
      const result = await fetchGlob({
        pattern: "**/*",
        limit: EXPLORER_GLOB_LIMIT,
        maxDepth: EXPLORER_EAGER_DEPTH,
      });
      applyGlobResult(result, false, generation);
      setTreeLoaded(true);
    } catch {
      if (treeLoaded) {
        toast.error("Failed to refresh file tree");
      }
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
          body: JSON.stringify({ path: toDaemonPath(path), full: true }),
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
      if (!res.ok) {
        saveChangesDebug("file save failed", {
          path,
          status: res.status,
        });
        return;
      }
      saveChangesDebug("file saved via sandbox /write", { path });
      void queryClient.invalidateQueries({
        queryKey: sandboxGitStatusQueryKey(orgSlug, virtualMcpId, branch),
      });
      try {
        const status = await fetchGitStatus(orgSlug, virtualMcpId, branch);
        saveChangesDebug("git status after save", status);
      } catch (err) {
        saveChangesDebug("git status after save failed", {
          path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
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
    setSelectedTreeNode({
      name: path.split("/").pop() ?? path,
      path,
      kind: "file",
      children: [],
    });
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

  async function expandDirectory(dirPath: string) {
    if (directoryNeedsLazyLoad(dirPath, loadedLazyDirsRef.current)) {
      try {
        const truncated = await loadLazyDirectory(dirPath);
        if (truncated) return;
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to load folder",
        );
        return;
      }
    }
    toggleDir(dirPath);
  }

  async function handleDirectoryOpen(dirPath: string, isExpanded: boolean) {
    if (isExpanded) {
      toggleDir(dirPath);
      return;
    }
    await expandDirectory(dirPath);
  }

  async function handleFileClick(path: string) {
    await initialTreeLoadRef.current;
    await ensureAncestorsLoaded(path);
    const ancestors = getAncestorDirectories(path);
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      for (const a of ancestors) next.add(a);
      return next;
    });
    openFile(path);
  }

  function getCreateParentDir(): string {
    if (selectedTreeNode?.kind === "directory") {
      return selectedTreeNode.path;
    }
    if (selectedTreeNode?.kind === "file") {
      return getParentTreePath(selectedTreeNode.path);
    }
    if (selectedFile) {
      return getParentTreePath(selectedFile);
    }
    return "/";
  }

  function openCreateDialog(mode: "new-file" | "new-folder") {
    const parentDir = getCreateParentDir();
    setNameDialog({
      mode,
      parentDir,
      node: {
        name: "",
        path: parentDir,
        kind: "directory",
        children: [],
      },
    });
  }

  const tree = buildFileTree(files, directories);
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

  const deleteDirtyPaths = deleteTarget
    ? getDirtyOpenPathsUnder(deleteTarget.path)
    : [];

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
        {/* Search + create */}
        <div className="flex items-center gap-1 p-2 border-b">
          <div className="relative min-w-0 flex-1">
            <SearchSm
              size={14}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search files..."
              aria-label="Search files"
              className="w-full rounded-md border border-input bg-transparent pl-7 pr-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
            />
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                aria-label="New file"
                onClick={() => openCreateDialog("new-file")}
              >
                <FilePlus01 size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">New file</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                aria-label="New folder"
                onClick={() => openCreateDialog("new-folder")}
              >
                <FolderPlus size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">New folder</TooltipContent>
          </Tooltip>
        </div>

        {/* Tree */}
        <ScrollArea className="flex-1">
          <div className="py-1">
            {filteredNodes.map((row) => {
              const { node, depth } = row;
              const isDir = node.kind === "directory";
              const isExpanded = expandedDirs.has(node.path);
              const isSelected = selectedTreeNode?.path === node.path;
              const parentDir = getDirectoryContextPath(node.path, node.kind);
              const isDirLoading = isDir && loadingDirs.has(node.path);

              return (
                <FileTreeRow
                  key={node.path}
                  node={node}
                  depth={depth}
                  isExpanded={isExpanded}
                  isSelected={isSelected}
                  isLoading={isDirLoading}
                  fileVisual={getFileVisual(node.name)}
                  onSelect={() => setSelectedTreeNode(node)}
                  onOpen={() => {
                    if (isDir) {
                      void handleDirectoryOpen(node.path, isExpanded);
                    } else {
                      void handleFileClick(node.path);
                    }
                  }}
                  onNewFile={() =>
                    setNameDialog({
                      mode: "new-file",
                      node,
                      parentDir,
                    })
                  }
                  onNewFolder={() =>
                    setNameDialog({
                      mode: "new-folder",
                      node,
                      parentDir,
                    })
                  }
                  onCopyPath={() => copyText("Path", toTreePath(node.path))}
                  onCopyRelativePath={() =>
                    copyText("Relative path", toDaemonPath(node.path))
                  }
                  onRename={() =>
                    setNameDialog({
                      mode: "rename",
                      node,
                      parentDir,
                    })
                  }
                  onDelete={() => setDeleteTarget(node)}
                />
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

      <FileExplorerNameDialog
        open={nameDialog !== null}
        mode={nameDialog?.mode ?? "new-file"}
        initialName={nameDialog?.mode === "rename" ? nameDialog.node.name : ""}
        parentLabel={
          nameDialog && nameDialog.mode !== "rename"
            ? nameDialog.parentDir === "/"
              ? "/"
              : toDaemonPath(nameDialog.parentDir)
            : undefined
        }
        isPending={fsActionPending}
        onSubmit={handleNameDialogSubmit}
        onOpenChange={(open) => {
          if (!open && !fsActionPending) setNameDialog(null);
        }}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !fsActionPending) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deleteTarget?.kind === "directory" ? "folder" : "file"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete{" "}
              <span className="font-mono">{deleteTarget?.name}</span>
              {deleteTarget?.kind === "directory"
                ? " and everything inside it."
                : "."}
              {deleteDirtyPaths.length > 0 && (
                <>
                  {" "}
                  {deleteDirtyPaths.length === 1
                    ? "One open file has unsaved changes that will be lost."
                    : `${deleteDirtyPaths.length} open files have unsaved changes that will be lost.`}
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={fsActionPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={fsActionPending || !deleteTarget}
              onClick={(e) => {
                e.preventDefault();
                if (deleteTarget) void handleDelete(deleteTarget);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
