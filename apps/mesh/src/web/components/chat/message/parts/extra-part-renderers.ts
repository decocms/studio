/**
 * Tiny extension point for rendering custom message parts inline in the chat.
 *
 * The core renderer (`message/assistant.tsx`) consults this registry before its
 * built-in switch, so non-core surfaces (e.g. Demo Mode) can render their own
 * part types in the real chat flow WITHOUT the core importing them. The registry
 * is empty in normal use; a consumer registers a renderer at module load.
 */
import type { ReactNode } from "react";

type PartRenderer = (part: { type: string; output?: unknown }) => ReactNode;

const registry = new Map<string, PartRenderer>();

export function registerPartRenderer(type: string, render: PartRenderer): void {
  registry.set(type, render);
}

export function getPartRenderer(type: string): PartRenderer | undefined {
  return registry.get(type);
}
