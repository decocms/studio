import {
  createContext,
  type Dispatch,
  type MutableRefObject,
  type ReactNode,
  type SetStateAction,
  use,
  useRef,
  useState,
} from "react";
import { LatestWriteQueue } from "./latest-write-queue";
import { fileBufferIsDirty } from "./file-tab-state";
import type { FileBuffer, FileOperationError, TreeNode } from "./types";

export interface CodeWorkspaceIdentity {
  orgSlug: string;
  virtualMcpId: string;
  branch: string | null;
  threadId: string | null;
}

type CompactCodePane = "tree" | "editor";

interface CodeWorkspaceContextValue {
  identity: CodeWorkspaceIdentity;
  buffers: Map<string, FileBuffer>;
  setBuffers: Dispatch<SetStateAction<Map<string, FileBuffer>>>;
  fileErrors: Map<string, FileOperationError>;
  setFileErrors: Dispatch<SetStateAction<Map<string, FileOperationError>>>;
  openTabs: string[];
  openTabPathsRef: MutableRefObject<string[]>;
  updateOpenTabs: (updater: (current: string[]) => string[]) => string[];
  selectedFile: string | null;
  setSelectedFile: Dispatch<SetStateAction<string | null>>;
  selectedTreeNode: TreeNode | null;
  setSelectedTreeNode: Dispatch<SetStateAction<TreeNode | null>>;
  compactPane: CompactCodePane;
  setCompactPane: Dispatch<SetStateAction<CompactCodePane>>;
  fileReadInflightRef: MutableRefObject<Map<string, Promise<string>>>;
  fileWriteQueue: LatestWriteQueue<string, string>;
  /** Includes retained drafts from another identity in this Site Editor visit. */
  hasUnsavedChanges: boolean;
  identityChangePending: boolean;
  requestIdentityChange: (change: () => void) => void;
  cancelIdentityChange: () => void;
  discardActiveSession: () => void;
  discardAndContinueIdentityChange: () => void;
}

const CodeWorkspaceContext = createContext<CodeWorkspaceContextValue | null>(
  null,
);

/**
 * Collision-safe identity for one sandbox-backed editing session. A route may
 * swap Preview, Content, and Code without changing this identity; a different
 * organization, agent, branch, or thread must never inherit its buffers.
 */
export function codeWorkspaceIdentityKey(
  identity: CodeWorkspaceIdentity,
): string {
  return JSON.stringify([
    identity.orgSlug,
    identity.virtualMcpId,
    identity.branch,
    identity.threadId,
  ]);
}

interface CodeWorkspaceState {
  buffers: Map<string, FileBuffer>;
  fileErrors: Map<string, FileOperationError>;
  openTabs: string[];
  selectedFile: string | null;
  selectedTreeNode: TreeNode | null;
  compactPane: CompactCodePane;
}

interface CodeWorkspaceResources {
  openTabPathsRef: MutableRefObject<string[]>;
  fileReadInflightRef: MutableRefObject<Map<string, Promise<string>>>;
  fileWriteQueue: LatestWriteQueue<string, string>;
}

function createCodeWorkspaceState(): CodeWorkspaceState {
  return {
    buffers: new Map(),
    fileErrors: new Map(),
    openTabs: [],
    selectedFile: null,
    selectedTreeNode: null,
    compactPane: "tree",
  };
}

function resolveStateAction<T>(action: SetStateAction<T>, current: T): T {
  return typeof action === "function"
    ? (action as (previous: T) => T)(current)
    : action;
}

/** Imperative IO belongs to the exact identity that started it. */
class CodeWorkspaceResourceCache {
  private readonly resources = new Map<string, CodeWorkspaceResources>();

  forIdentity(identityKey: string): CodeWorkspaceResources {
    const existing = this.resources.get(identityKey);
    if (existing) return existing;
    const created: CodeWorkspaceResources = {
      openTabPathsRef: { current: [] },
      fileReadInflightRef: { current: new Map() },
      fileWriteQueue: new LatestWriteQueue<string, string>(),
    };
    this.resources.set(identityKey, created);
    return created;
  }
}

function CodeWorkspaceSession({
  identity,
  children,
}: {
  identity: CodeWorkspaceIdentity;
  children: ReactNode;
}) {
  const identityKey = codeWorkspaceIdentityKey(identity);
  const [sessions, setSessions] = useState<
    ReadonlyMap<string, CodeWorkspaceState>
  >(() => new Map());
  const [resourceCache] = useState(() => new CodeWorkspaceResourceCache());
  const activeSession = sessions.get(identityKey) ?? createCodeWorkspaceState();
  const { openTabPathsRef, fileReadInflightRef, fileWriteQueue } =
    resourceCache.forIdentity(identityKey);
  const pendingIdentityChangeRef = useRef<(() => void) | null>(null);
  const [identityChangePending, setIdentityChangePending] = useState(false);
  const activeHasUnsavedChanges = Array.from(
    activeSession.buffers.values(),
  ).some(fileBufferIsDirty);
  const hasUnsavedChanges = Array.from(sessions.values()).some((session) =>
    Array.from(session.buffers.values()).some(fileBufferIsDirty),
  );

  function updateActiveSession(
    update: (current: CodeWorkspaceState) => CodeWorkspaceState,
  ): void {
    setSessions((current) => {
      const previous = current.get(identityKey) ?? activeSession;
      const nextSession = update(previous);
      if (nextSession === previous) return current;
      const next = new Map(current);
      next.delete(identityKey);
      next.set(identityKey, nextSession);
      return next;
    });
  }

  const setBuffers: Dispatch<SetStateAction<Map<string, FileBuffer>>> = (
    action,
  ) => {
    updateActiveSession((current) => {
      const buffers = resolveStateAction(action, current.buffers);
      return buffers === current.buffers ? current : { ...current, buffers };
    });
  };

  const setFileErrors: Dispatch<
    SetStateAction<Map<string, FileOperationError>>
  > = (action) => {
    updateActiveSession((current) => {
      const fileErrors = resolveStateAction(action, current.fileErrors);
      return fileErrors === current.fileErrors
        ? current
        : { ...current, fileErrors };
    });
  };

  const setSelectedFile: Dispatch<SetStateAction<string | null>> = (action) => {
    updateActiveSession((current) => {
      const selectedFile = resolveStateAction(action, current.selectedFile);
      return selectedFile === current.selectedFile
        ? current
        : { ...current, selectedFile };
    });
  };

  const setSelectedTreeNode: Dispatch<SetStateAction<TreeNode | null>> = (
    action,
  ) => {
    updateActiveSession((current) => {
      const selectedTreeNode = resolveStateAction(
        action,
        current.selectedTreeNode,
      );
      return selectedTreeNode === current.selectedTreeNode
        ? current
        : { ...current, selectedTreeNode };
    });
  };

  const setCompactPane: Dispatch<SetStateAction<CompactCodePane>> = (
    action,
  ) => {
    updateActiveSession((current) => {
      const compactPane = resolveStateAction(action, current.compactPane);
      return compactPane === current.compactPane
        ? current
        : { ...current, compactPane };
    });
  };

  function updateOpenTabs(updater: (current: string[]) => string[]): string[] {
    const next = updater(openTabPathsRef.current);
    openTabPathsRef.current = next;
    updateActiveSession((current) =>
      next === current.openTabs ? current : { ...current, openTabs: next },
    );
    return next;
  }

  function requestIdentityChange(change: () => void): void {
    if (!activeHasUnsavedChanges) {
      change();
      return;
    }
    pendingIdentityChangeRef.current = change;
    setIdentityChangePending(true);
  }

  function cancelIdentityChange(): void {
    pendingIdentityChangeRef.current = null;
    setIdentityChangePending(false);
  }

  function discardActiveSession(): void {
    updateActiveSession(() => createCodeWorkspaceState());
    openTabPathsRef.current = [];
    fileReadInflightRef.current.clear();
  }

  function discardAndContinueIdentityChange(): void {
    const change = pendingIdentityChangeRef.current;
    pendingIdentityChangeRef.current = null;
    setIdentityChangePending(false);
    if (!change) return;

    discardActiveSession();
    change();
  }

  return (
    <CodeWorkspaceContext
      value={{
        identity,
        buffers: activeSession.buffers,
        setBuffers,
        fileErrors: activeSession.fileErrors,
        setFileErrors,
        openTabs: activeSession.openTabs,
        openTabPathsRef,
        updateOpenTabs,
        selectedFile: activeSession.selectedFile,
        setSelectedFile,
        selectedTreeNode: activeSession.selectedTreeNode,
        setSelectedTreeNode,
        compactPane: activeSession.compactPane,
        setCompactPane,
        fileReadInflightRef,
        fileWriteQueue,
        hasUnsavedChanges,
        identityChangePending,
        requestIdentityChange,
        cancelIdentityChange,
        discardActiveSession,
        discardAndContinueIdentityChange,
      }}
    >
      {children}
    </CodeWorkspaceContext>
  );
}

/**
 * Owns Code's in-memory editing state at the Site Editor route boundary. Each
 * backing identity has an isolated in-memory session. Retaining prior
 * sessions for this mounted Site Editor prevents an indirect thread or branch
 * update from destroying a draft; nothing is persisted to storage.
 */
export function CodeWorkspaceProvider({
  identity,
  children,
}: {
  identity: CodeWorkspaceIdentity;
  children: ReactNode;
}) {
  return (
    <CodeWorkspaceSession identity={identity}>{children}</CodeWorkspaceSession>
  );
}

export function useCodeWorkspace(): CodeWorkspaceContextValue {
  const context = use(CodeWorkspaceContext);
  if (!context) {
    throw new Error(
      "useCodeWorkspace must be used inside <CodeWorkspaceProvider>",
    );
  }
  return context;
}
