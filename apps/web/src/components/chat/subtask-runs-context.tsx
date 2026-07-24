import { createContext, useContext, type ReactNode } from "react";
import type { ChatMessage } from "./types.ts";

/**
 * Maps a subtask `jobId` → the backgrounded subagent run's messages (those
 * carrying `metadata.subtaskJobId`). Built once at the message-list level (the
 * only place with the full message array) and read by the `subtask` tool card
 * so it can render the run NESTED inside itself instead of top-level.
 */
const SubtaskRunsContext = createContext<Map<string, ChatMessage[]>>(new Map());

export function SubtaskRunsProvider({
  messages,
  children,
}: {
  messages: ChatMessage[];
  children: ReactNode;
}) {
  const byJob = new Map<string, ChatMessage[]>();
  for (const m of messages) {
    const jobId = m.metadata?.subtaskJobId;
    if (!jobId) continue;
    const arr = byJob.get(jobId);
    if (arr) arr.push(m);
    else byJob.set(jobId, [m]);
  }
  return (
    <SubtaskRunsContext.Provider value={byJob}>
      {children}
    </SubtaskRunsContext.Provider>
  );
}

/** The backgrounded subagent run's messages for a subtask `jobId` (empty until
 *  the run starts streaming). */
export function useSubtaskRun(jobId: string | undefined): ChatMessage[] {
  const map = useContext(SubtaskRunsContext);
  return jobId ? (map.get(jobId) ?? []) : [];
}
