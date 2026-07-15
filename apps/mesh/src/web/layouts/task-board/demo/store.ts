/**
 * Tiny external store for the scripted demo board. Plain object plus
 * subscribe/getSnapshot for useSyncExternalStore. All timed behavior is
 * driven from user-initiated actions (no timers on mount) and every
 * duration is deterministic by task index.
 */

import { sleep } from "@decocms/std";
import type { TaskBoardItemPriority, TaskBoardItemStatus } from "../config";
import {
  DEMO_TASK_SEEDS,
  type DemoAssignee,
  type DemoSession,
  type DemoTask,
} from "./data";

export type DemoPhase = "idle" | "generating" | "running" | "done";

export interface DemoState {
  phase: DemoPhase;
  autoMerge: boolean;
  tasks: DemoTask[];
  activeChatSession: DemoSession | null;
}

const INITIAL_STATE: DemoState = {
  phase: "idle",
  autoMerge: false,
  tasks: [],
  activeChatSession: null,
};

/** How many tasks the Deco agent works on at the same time. */
const CONCURRENCY = 3;
const STREAM_DELAY_MS = 140;
const MERGE_DELAY_MS = 1200;
const MERGE_STAGGER_MS = 400;

let state: DemoState = INITIAL_STATE;
/** Bumped on reset so in-flight async scripts from a previous run stop. */
let epoch = 0;
const listeners = new Set<() => void>();

function emit(next: DemoState) {
  state = next;
  for (const listener of listeners) listener();
}

function patchTask(id: string, patch: Partial<DemoTask>) {
  emit({
    ...state,
    tasks: state.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
  });
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot(): DemoState {
  return state;
}

async function mergeAfter(id: string, delayMs: number) {
  await sleep(delayMs);
  const task = state.tasks.find((t) => t.id === id);
  if (!task || task.status !== "in_review" || task.prStatus !== "open") return;
  patchTask(id, { prStatus: "merged", status: "done" });
}

/** Streams the backlog in, then runs the Deco agent simulation. */
export async function generateBacklog() {
  if (state.phase !== "idle") return;
  const run = epoch;
  emit({ ...state, phase: "generating" });

  for (const seed of DEMO_TASK_SEEDS) {
    await sleep(STREAM_DELAY_MS);
    if (run !== epoch) return;
    const task: DemoTask = { ...seed, status: seed.initialStatus };
    emit({ ...state, tasks: [...state.tasks, task] });
  }

  emit({ ...state, phase: "running" });

  // The agent picks up every todo task that has a scripted PR, a few at a
  // time, until all of them reach in_review (or done via auto merge).
  const queue = state.tasks
    .filter((t) => t.pr && t.status === "todo")
    .map((t) => t.id);

  const worker = async () => {
    for (;;) {
      const id = queue.shift();
      if (!id || run !== epoch) return;
      const index = DEMO_TASK_SEEDS.findIndex((s) => s.id === id);
      patchTask(id, { status: "in_progress" });
      // Deterministic 5-10s per task, varied by seed index.
      await sleep(5000 + (index % 6) * 1000);
      if (run !== epoch) return;
      patchTask(id, { status: "in_review", prStatus: "open" });
      if (state.autoMerge) void mergeAfter(id, MERGE_DELAY_MS);
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  if (run !== epoch) return;
  emit({ ...state, phase: "done" });
}

export function toggleAutoMerge(on: boolean) {
  emit({ ...state, autoMerge: on });
  if (!on) return;
  const inReview = state.tasks.filter(
    (t) => t.status === "in_review" && t.prStatus === "open",
  );
  inReview.forEach((task, i) => {
    void mergeAfter(task.id, MERGE_DELAY_MS + i * MERGE_STAGGER_MS);
  });
}

export function moveTask(id: string, status: TaskBoardItemStatus) {
  patchTask(id, { status });
}

export function setPriority(id: string, priority: TaskBoardItemPriority) {
  patchTask(id, { priority });
}

export function setAssignee(id: string, assignee: DemoAssignee | null) {
  patchTask(id, { assignee });
}

export function setActiveChatSession(session: DemoSession) {
  emit({ ...state, activeChatSession: session });
}

export function clearActiveChatSession() {
  emit({ ...state, activeChatSession: null });
}

export function reset() {
  epoch += 1;
  emit(INITIAL_STATE);
}
