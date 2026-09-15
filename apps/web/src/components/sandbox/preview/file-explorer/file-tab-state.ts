import type { FileBuffer } from "./types";

export function fileBufferIsDirty(buffer: FileBuffer | undefined): boolean {
  return Boolean(buffer?.loaded && buffer.editorValue !== buffer.savedContent);
}

/** Pick the adjacent surviving tab when the active tab closes. */
export function activeFileAfterTabClose(
  openTabs: readonly string[],
  activeFile: string | null,
  closingFile: string,
): string | null {
  if (activeFile !== closingFile) return activeFile;

  const closingIndex = openTabs.indexOf(closingFile);
  if (closingIndex === -1) return activeFile;
  return openTabs[closingIndex + 1] ?? openTabs[closingIndex - 1] ?? null;
}

export function tabIndexForKey(
  key: string,
  currentIndex: number,
  tabCount: number,
): number | null {
  if (tabCount <= 0 || currentIndex < 0) return null;
  switch (key) {
    case "ArrowLeft":
      return (currentIndex - 1 + tabCount) % tabCount;
    case "ArrowRight":
      return (currentIndex + 1) % tabCount;
    case "Home":
      return 0;
    case "End":
      return tabCount - 1;
    default:
      return null;
  }
}
