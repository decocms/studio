export interface SourceSystemTab {
  id: "preview" | "blocks" | "code";
  title: string;
}

const SOURCE_SYSTEM_TABS: readonly SourceSystemTab[] = [
  { id: "blocks", title: "Blocks" },
  { id: "preview", title: "Preview" },
  { id: "code", title: "Code" },
];

export function getSourceSystemTabs(
  hasClonableSource: boolean,
): SourceSystemTab[] {
  return hasClonableSource ? [...SOURCE_SYSTEM_TABS] : [];
}
