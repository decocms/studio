/**
 * External store for capybara animation frame index.
 * Uses setInterval (not useEffect) so components subscribe via useSyncExternalStore.
 */
import { CAPY_FRAMES, type Segment } from "./capy-frames";

const FPS = 10;
const FRAME_MS = 1000 / FPS;

let frameIndex = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

export type { Segment };

export function getCapyFrame(): Segment[][] {
  return CAPY_FRAMES[frameIndex]!;
}

export function subscribeCapyFrame(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function startCapyAnimation(): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    frameIndex = (frameIndex + 1) % CAPY_FRAMES.length;
    emit();
  }, FRAME_MS);
}

export function stopCapyAnimation(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  frameIndex = 0;
  emit();
}
