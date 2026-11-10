import { toTitleCase } from "@/components/chat/message/parts/tool-call-part/utils";

const SCREEN_APP_PREFIX = /^app_/i;

/** Tools named `APP_*` are screens meant to open full screen from the
 *  sidebar, as opposed to UI widgets that render inside a chat. */
export function isScreenAppTool(name: string): boolean {
  return SCREEN_APP_PREFIX.test(name) && name.length > 4;
}

export function appToolLabel(tool: { name: string; title?: string }): string {
  if (tool.title) return tool.title;
  return toTitleCase(
    isScreenAppTool(tool.name)
      ? tool.name.replace(SCREEN_APP_PREFIX, "")
      : tool.name,
  );
}

/** Screen apps first; the rest keep their order. */
export function screenAppsFirst<T extends { name: string }>(tools: T[]): T[] {
  return tools.toSorted(
    (a, b) => Number(isScreenAppTool(b.name)) - Number(isScreenAppTool(a.name)),
  );
}
