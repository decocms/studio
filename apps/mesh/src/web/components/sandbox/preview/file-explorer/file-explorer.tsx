import { useQueryClient } from "@tanstack/react-query";
import { useState, useRef } from "react";
import Editor, { loader } from "@monaco-editor/react";
import type { OnMount } from "@monaco-editor/react";
import {
  FilePlus01,
  FolderPlus,
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
import { toast } from "sonner";
import { useChatStream } from "@/web/components/chat/context";
import { usePanelActions } from "@/web/layouts/shell-layout";
import { useT } from "@/web/i18n/use-t.ts";
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
import { FileExplorerDeleteDialog } from "./file-explorer-delete-dialog";
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
  getFileVisual,
  getLanguageFromPath,
  getParentTreePath,
  buildGrepHighlight,
  groupGrepMatches,
  isSafeExplorerOpenPath,
  joinTreePath,
  matchFileNames,
  mergeGlobLists,
  parseGrepContent,
  pathExistsInFileList,
  stripLineNumbers,
  toDaemonPath,
  toTreePath,
  validateExplorerEntryName,
  type GlobListResult,
  type GrepContentMatch,
} from "./utils";

// Configure Monaco CDN (shared with workflow editor)
loader.config({
  paths: {
    vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs",
  },
});

/** Max content-search hits requested from the daemon grep endpoint. */
const CONTENT_SEARCH_LIMIT = 200;
/** Minimum query length before firing a (whole-repo) content search. */
const CONTENT_SEARCH_MIN_CHARS = 2;
/** Debounce before firing the search as the user types. */
const SEARCH_DEBOUNCE_MS = 250;
/** Max filename matches rendered in the search results. */
const FILENAME_MATCH_LIMIT = 200;

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

/** A grep result line with the matched query runs highlighted (VS Code-style). */
function GrepMatchLine({ text, query }: { text: string; query: string }) {
  const { leadingEllipsis, segments } = buildGrepHighlight(text, query);
  return (
    <span className="truncate font-mono text-muted-foreground">
      {leadingEllipsis && <span className="text-muted-foreground/50">…</span>}
      {segments.map((segment, index) =>
        segment.match ? (
          <span
            // Segments are positional within a single line; index is stable.
            key={index}
            className="rounded-[2px] bg-primary/20 text-foreground"
          >
            {segment.text}
          </span>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </span>
  );
}

export function FileExplorer({
  orgSlug,
  virtualMcpId,
  branch,
  openPath,
}: FileExplorerProps) {
  // File tree state
  const [treeLists, setTreeLists] = useState<{
    files: string[];
    directories: string[];
    truncated: boolean;
  }>({ files: [], directories: [], truncated: false });
  const { files, directories } = treeLists;
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedTreeNode, setSelectedTreeNode] = useState<TreeNode | null>(
    null,
  );
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  // Filename matches across the WHOLE repo (not just the loaded tree). `null` =
  // not searching; `[]` = searched, no hits. Tree paths (leading slash).
  const [fileNameMatches, setFileNameMatches] = useState<string[] | null>(null);
  // Content search (ripgrep over the whole repo). `null` = not searching /
  // query too short; `[]` = searched, no hits.
  const [contentMatches, setContentMatches] = useState<
    GrepContentMatch[] | null
  >(null);
  const [contentSearching, setContentSearching] = useState(false);
  const [contentSearchTruncated, setContentSearchTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [treeLoaded, setTreeLoaded] = useState(false);
  const [, setLoadedLazyDirs] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());

  const treeGenerationRef = useRef(0);
  const initialTreeLoadRef = useRef<Promise<void> | null>(null);
  const loadedLazyDirsRef = useRef<Set<string>>(new Set());
  const lazyLoadInflightRef = useRef<Map<string, Promise<boolean>>>(new Map());
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped on every query change so a slow in-flight search (filename glob or
  // content grep) can't clobber a newer one (or a cleared search) on resolve.
  const searchGenRef = useRef(0);
  // Cache of the whole-repo path list (all depths) used for filename search, so
  // matches aren't limited to the lazily-loaded/expanded tree. Keyed by tree
  // generation so it's invalidated whenever the tree is reloaded.
  const allPathsRef = useRef<{
    generation: number;
    files: string[];
  } | null>(null);
  // In-flight whole-repo glob (keyed by generation), so two searches that
  // both miss the cache before the first glob resolves share one request
  // instead of each firing their own full-repo walk.
  const allPathsInflightRef = useRef<{
    generation: number;
    promise: Promise<string[]>;
  } | null>(null);
  // Line to reveal once the target file's editor mounts (set when opening a
  // content-search hit).
  const pendingRevealRef = useRef<{ path: string; line: number } | null>(null);

  function updateLoadedLazyDirs(
    updater: Set<string> | ((prev: Set<string>) => Set<string>),
  ) {
    setLoadedLazyDirs((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      loadedLazyDirsRef.current = next;
      return next;
    });
  }

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
  const { openSidePanel } = usePanelActions();
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

  function copyText(t: ReturnType<typeof useT>, label: string, value: string) {
    void navigator.clipboard.writeText(value).then(
      () => toast.success(t("sandbox.fileExplorer.textCopied", { label })),
      () =>
        toast.error(
          t("sandbox.fileExplorer.failedToCopyText", {
            label: label.toLowerCase(),
          }),
        ),
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
    void queryClient.invalidateQueries({
      queryKey: KEYS.liveMeta(orgSlug, virtualMcpId, branch),
    });
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

  async function handleCreateFile(t: ReturnType<typeof useT>, name: string) {
    if (!nameDialog) return;
    const filePath = joinTreePath(nameDialog.parentDir, name);
    if (pathExistsInFileList(filePath, files, directories)) {
      throw new Error(t("sandbox.fileExplorer.fileAlreadyExists", { name }));
    }
    await postSandbox("write", {
      path: toDaemonPath(filePath),
      content: "",
    });
    await fetchFileTree();
    await refreshGitStatus();
    setNameDialog(null);
    openFileGuarded(filePath);
  }

  async function handleCreateFolder(t: ReturnType<typeof useT>, name: string) {
    if (!nameDialog) return;
    const folderPath = joinTreePath(nameDialog.parentDir, name);
    if (pathExistsInFileList(folderPath, files, directories)) {
      throw new Error(t("sandbox.fileExplorer.fileAlreadyExists", { name }));
    }
    const daemonFolderPath = toDaemonPath(folderPath);
    await postSandbox("mkdir", { path: daemonFolderPath });
    setTreeLists((prev) => ({
      ...prev,
      directories: prev.directories.includes(daemonFolderPath)
        ? prev.directories
        : [...prev.directories, daemonFolderPath],
    }));
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

  async function handleRename(t: ReturnType<typeof useT>, name: string) {
    if (!nameDialog) return;
    const fromPath = nameDialog.node.path;
    const parentDir = getParentTreePath(fromPath);
    const toPath = joinTreePath(parentDir, name);
    if (toPath === fromPath) {
      setNameDialog(null);
      return;
    }
    if (pathExistsInFileList(toPath, files, directories)) {
      throw new Error(t("sandbox.fileExplorer.fileAlreadyExists", { name }));
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

  async function handleDelete(t: ReturnType<typeof useT>, node: TreeNode) {
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
      toast.success(t("sandbox.fileExplorer.fileDeleted", { name: node.name }));
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("sandbox.fileExplorer.deleteFailed"),
      );
    } finally {
      setFsActionPending(false);
    }
  }

  async function handleNameDialogSubmit(
    t: ReturnType<typeof useT>,
    name: string,
  ) {
    const validationError = validateExplorerEntryName(name);
    if (validationError) {
      toast.error(validationError);
      return;
    }
    setFsActionPending(true);
    try {
      if (nameDialog?.mode === "new-file") {
        await handleCreateFile(t, name);
        toast.success(t("sandbox.fileExplorer.fileCreated", { name }));
      } else if (nameDialog?.mode === "new-folder") {
        await handleCreateFolder(t, name);
        toast.success(t("sandbox.fileExplorer.folderCreated", { name }));
      } else if (nameDialog?.mode === "rename") {
        await handleRename(t, name);
        toast.success(t("sandbox.fileExplorer.renamedTo", { name }));
      }
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("sandbox.fileExplorer.operationFailed"),
      );
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
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- one-shot fetch trigger
    initialTreeLoadRef.current = fetchFileTree();
  }

  // Deep-link: open the requested file when `openPath` is set or changes.
  const [prevOpenPath, setPrevOpenPath] = useState<string | null>(null);
  const t = useT();
  if (openPath && openPath !== prevOpenPath) {
    setPrevOpenPath(openPath);
    const pathToOpen = openPath;
    queueMicrotask(() => {
      if (isSafeExplorerOpenPath(pathToOpen)) {
        openFileGuarded(pathToOpen);
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

    let truncated = false;
    setTreeLists((prev) => {
      const merged = merge
        ? mergeGlobLists(prev.files, prev.directories, result, prev.truncated)
        : {
            files: result.files,
            directories: result.directories ?? [],
            truncated: Boolean(result.truncated),
          };
      truncated = Boolean(merged.truncated);
      return {
        files: merged.files,
        directories: merged.directories,
        truncated,
      };
    });
    if (truncated) {
      toast.warning(t("sandbox.fileExplorer.fileListTruncated"));
    }
    return truncated;
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
        updateLoadedLazyDirs((prev) => {
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

  async function ensureAncestorsLoaded(
    t: ReturnType<typeof useT>,
    treePath: string,
  ) {
    const loaded = new Set(loadedLazyDirsRef.current);
    for (const dir of getAncestorDirectories(treePath)) {
      if (!directoryNeedsLazyLoad(dir, loaded)) continue;
      const truncated = await loadLazyDirectory(dir);
      if (truncated) {
        throw new Error(t("sandbox.fileExplorer.folderListingTruncated"));
      }
      loaded.add(dir);
    }
  }

  async function fetchFileTree() {
    const generation = ++treeGenerationRef.current;
    allPathsRef.current = null;
    allPathsInflightRef.current = null;
    lazyLoadInflightRef.current.clear();
    setLoading(true);
    updateLoadedLazyDirs(new Set());
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
        toast.error(t("sandbox.fileExplorer.failedToRefreshFileTree"));
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
      const data = (await postSandbox("read", {
        path: toDaemonPath(path),
        full: true,
      })) as {
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

  function clearSearchResults() {
    // Invalidate any in-flight search so its result can't land after we clear.
    searchGenRef.current++;
    setFileNameMatches(null);
    setContentMatches(null);
    setContentSearching(false);
    setContentSearchTruncated(false);
  }

  /**
   * Whole-repo path list (all depths), cached per tree generation. Two
   * searches that both miss the cache before the first glob resolves share
   * the same in-flight request rather than each firing a full-repo walk.
   */
  async function ensureAllPaths(): Promise<string[]> {
    const generation = treeGenerationRef.current;
    const cached = allPathsRef.current;
    if (cached && cached.generation === generation) return cached.files;
    const inflight = allPathsInflightRef.current;
    if (inflight && inflight.generation === generation) return inflight.promise;

    const promise = (async () => {
      // No maxDepth → every file, unlike the eager tree (depth-capped) and
      // the lazy per-directory loads.
      const result = await fetchGlob({
        pattern: "**/*",
        limit: EXPLORER_GLOB_LIMIT,
      });
      if (treeGenerationRef.current === generation) {
        allPathsRef.current = { generation, files: result.files };
      }
      return result.files;
    })();
    allPathsInflightRef.current = { generation, promise };
    try {
      return await promise;
    } finally {
      if (allPathsInflightRef.current?.generation === generation) {
        allPathsInflightRef.current = null;
      }
    }
  }

  async function runFileNameSearch(term: string, gen: number) {
    try {
      const files = await ensureAllPaths();
      if (gen !== searchGenRef.current) return; // superseded
      setFileNameMatches(matchFileNames(files, term, FILENAME_MATCH_LIMIT));
    } catch {
      if (gen !== searchGenRef.current) return;
      setFileNameMatches([]);
    }
  }

  async function runContentSearch(term: string, gen: number) {
    setContentSearching(true);
    try {
      const data = (await postSandbox("grep", {
        pattern: term,
        output_mode: "content",
        ignore_case: true,
        // Literal substring match, mirroring the filename filter — the user
        // isn't writing a regex in the file-search box.
        fixed_strings: true,
        limit: CONTENT_SEARCH_LIMIT,
      })) as { results?: string; matchCount?: number };
      if (gen !== searchGenRef.current) return; // superseded
      setContentMatches(parseGrepContent(data.results ?? ""));
      setContentSearchTruncated((data.matchCount ?? 0) >= CONTENT_SEARCH_LIMIT);
    } catch {
      if (gen !== searchGenRef.current) return;
      setContentMatches([]);
      setContentSearchTruncated(false);
    } finally {
      if (gen === searchGenRef.current) setContentSearching(false);
    }
  }

  function runSearch(term: string) {
    const trimmed = term.trim();
    const gen = ++searchGenRef.current;
    // Filename search fires from the first character; content search waits for
    // 2+ chars (a whole-repo grep on a single char is noise).
    void runFileNameSearch(trimmed, gen);
    if (trimmed.length < CONTENT_SEARCH_MIN_CHARS) {
      setContentMatches(null);
      setContentSearching(false);
      setContentSearchTruncated(false);
    } else {
      void runContentSearch(trimmed, gen);
    }
  }

  function handleSearchChange(value: string) {
    setSearch(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (!value.trim()) {
      clearSearchResults();
      return;
    }
    searchDebounceRef.current = setTimeout(() => {
      runSearch(value);
    }, SEARCH_DEBOUNCE_MS);
  }

  function applyPendingReveal(editor: Parameters<OnMount>[0]) {
    const pending = pendingRevealRef.current;
    if (!pending || pending.path !== selectedFile) return;
    pendingRevealRef.current = null;
    const line = Math.max(1, pending.line);
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.focus();
  }

  function openContentMatch(match: GrepContentMatch) {
    pendingRevealRef.current = { path: match.path, line: match.line };
    const alreadyOpen =
      selectedFile === match.path && buffers.get(match.path)?.loaded;
    openFileGuarded(match.path);
    // Same file already mounted → no remount fires, so reveal immediately.
    if (alreadyOpen && editorRef.current) applyPendingReveal(editorRef.current);
  }

  async function saveFile(path: string, content: string) {
    try {
      await postSandbox("write", { path: toDaemonPath(path), content });
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
    } catch (err) {
      saveChangesDebug("file save failed", {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
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
          err instanceof Error
            ? err.message
            : t("sandbox.fileExplorer.failedToLoadFolder"),
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
    await ensureAncestorsLoaded(t, path);
    const ancestors = getAncestorDirectories(path);
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      for (const a of ancestors) next.add(a);
      return next;
    });
    openFile(path);
  }

  /**
   * Fire-and-forget `handleFileClick`, surfacing a toast if it rejects (e.g.
   * `ensureAncestorsLoaded` throwing on a truncated folder listing) instead of
   * leaving an unhandled rejection with no user-facing feedback.
   */
  function openFileGuarded(path: string) {
    void handleFileClick(path).catch((err) => {
      toast.error(
        err instanceof Error
          ? err.message
          : t("sandbox.fileExplorer.failedToOpenFile"),
      );
    });
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

  const fileNameMatchCount = fileNameMatches?.length ?? 0;
  const contentGroups = groupGrepMatches(contentMatches ?? []);
  const contentMatchCount = contentMatches?.length ?? 0;

  const currentBuffer = selectedFile ? buffers.get(selectedFile) : null;
  const isDirty =
    currentBuffer?.loaded &&
    currentBuffer.editorValue !== currentBuffer.savedContent;

  const deleteDirtyPaths = deleteTarget
    ? getDirtyOpenPathsUnder(deleteTarget.path)
    : [];

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;

    // Jump to a content-search hit's line once the editor is ready.
    applyPendingReveal(editor);

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
    openSidePanel("chat");
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
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder={t("sandbox.fileExplorer.searchFilesPlaceholder")}
              aria-label={t("sandbox.fileExplorer.searchFilesLabel")}
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
                aria-label={t("sandbox.fileExplorer.newFileLabel")}
                onClick={() => openCreateDialog("new-file")}
              >
                <FilePlus01 size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t("sandbox.fileExplorer.newFile")}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                aria-label={t("sandbox.fileExplorer.newFolderLabel")}
                onClick={() => openCreateDialog("new-folder")}
              >
                <FolderPlus size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t("sandbox.fileExplorer.newFolder")}
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Tree */}
        <ScrollArea className="flex-1">
          <div className="py-1">
            {/* Lazy file tree (shown when not searching) */}
            {!search &&
              flatNodes.map((row) => {
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
                        openFileGuarded(node.path);
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
                    onCopyPath={() =>
                      copyText(t, "Path", toTreePath(node.path))
                    }
                    onCopyRelativePath={() =>
                      copyText(t, "Relative path", toDaemonPath(node.path))
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
            {!search && treeLoaded && flatNodes.length === 0 && (
              <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                {t("sandbox.fileExplorer.noFilesFound")}
              </div>
            )}

            {/* Filename matches (whole repo, independent of tree expansion) */}
            {search && (
              <>
                <div className="flex items-center gap-1.5 px-3 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  <span>{t("sandbox.fileExplorer.files")}</span>
                  {fileNameMatchCount > 0 && (
                    <span className="normal-case tracking-normal text-muted-foreground/70">
                      {fileNameMatchCount}
                      {fileNameMatchCount >= FILENAME_MATCH_LIMIT ? "+" : ""}
                    </span>
                  )}
                </div>
                {fileNameMatches !== null && fileNameMatches.length === 0 && (
                  <div className="px-3 py-1 text-xs text-muted-foreground">
                    {t("sandbox.fileExplorer.noFileNamesMatch")}
                  </div>
                )}
                {fileNameMatches?.map((path) => {
                  const name = path.split("/").pop() ?? path;
                  const dir = getParentTreePath(path);
                  const { Icon, color } = getFileVisual(name);
                  const isSelected = selectedFile === path;
                  return (
                    <button
                      key={path}
                      type="button"
                      onClick={() => openFileGuarded(path)}
                      title={path}
                      className={cn(
                        "flex w-full items-center gap-1.5 px-3 py-1 text-left text-xs hover:bg-accent",
                        isSelected && "bg-accent",
                      )}
                    >
                      <Icon size={14} className={cn("shrink-0", color)} />
                      <span className="max-w-40 shrink-0 truncate">{name}</span>
                      {dir !== "/" && (
                        <span className="truncate text-muted-foreground/60">
                          {dir}
                        </span>
                      )}
                    </button>
                  );
                })}
              </>
            )}

            {/* Content matches (ripgrep over the whole repo) */}
            {search && (
              <div className="mt-1 border-t pt-1">
                <div className="flex items-center gap-1.5 px-3 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  <span>{t("sandbox.fileExplorer.inFiles")}</span>
                  {contentMatchCount > 0 && (
                    <span className="text-muted-foreground/70 normal-case tracking-normal">
                      {contentMatchCount}
                      {contentSearchTruncated ? "+" : ""}
                    </span>
                  )}
                  {contentSearching && (
                    <Loading01 size={10} className="animate-spin" />
                  )}
                </div>
                {!contentSearching &&
                  contentMatches !== null &&
                  contentGroups.length === 0 && (
                    <div className="px-3 py-1 text-xs text-muted-foreground">
                      {t("sandbox.fileExplorer.noMatchesInFileContents")}
                    </div>
                  )}
                {contentGroups.map((group) => {
                  const name = group.path.split("/").pop() ?? group.path;
                  const { Icon, color } = getFileVisual(name);
                  return (
                    <div key={group.path}>
                      <div className="flex items-center gap-1.5 px-3 py-1 text-xs text-muted-foreground">
                        <Icon size={14} className={cn("shrink-0", color)} />
                        <span className="truncate">{name}</span>
                        <span className="text-muted-foreground/60">
                          {group.matches.length}
                        </span>
                      </div>
                      {group.matches.map((match) => (
                        <button
                          key={`${group.path}:${match.line}`}
                          type="button"
                          onClick={() => openContentMatch(match)}
                          title={`${group.path}:${match.line}`}
                          className="flex w-full items-baseline gap-2 pl-8 pr-3 py-0.5 text-left text-xs hover:bg-accent"
                        >
                          <span className="shrink-0 tabular-nums text-muted-foreground">
                            {match.line}
                          </span>
                          <GrepMatchLine text={match.text} query={search} />
                        </button>
                      ))}
                    </div>
                  );
                })}
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
                placeholder={t("sandbox.fileExplorer.askTheAiPlaceholder")}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Escape") setAskAi(null);
                }}
              />
              <button
                type="submit"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-opacity"
                title={t("sandbox.fileExplorer.send")}
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="none"
                  aria-hidden="true"
                >
                  <title>{t("sandbox.fileExplorer.send")}</title>
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
              {t("sandbox.fileExplorer.selectFileToEdit")}
            </div>
          )}
        </div>

        {/* Status bar */}
        {selectedFile && (
          <div className="flex items-center justify-between px-3 py-1 border-t text-[11px] text-muted-foreground shrink-0">
            <span className="truncate">{selectedFile}</span>
            <span>
              {isDirty
                ? t("sandbox.fileExplorer.modified")
                : t("sandbox.fileExplorer.saved")}{" "}
              &middot; {getLanguageFromPath(selectedFile)}
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
        onSubmit={(name) => handleNameDialogSubmit(t, name)}
        onOpenChange={(open) => {
          if (!open && !fsActionPending) setNameDialog(null);
        }}
      />

      <FileExplorerDeleteDialog
        deleteTarget={deleteTarget}
        deleteDirtyPaths={deleteDirtyPaths}
        fsActionPending={fsActionPending}
        onOpenChange={(open) => {
          if (!open && !fsActionPending) setDeleteTarget(null);
        }}
        onConfirm={(node) => void handleDelete(t, node)}
      />
    </div>
  );
}
