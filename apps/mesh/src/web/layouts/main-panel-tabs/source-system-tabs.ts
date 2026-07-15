export interface SourceSystemTab {
  id: "preview" | "code";
  title: string;
}

const SOURCE_SYSTEM_TABS: readonly SourceSystemTab[] = [
  { id: "preview", title: "Preview" },
  { id: "code", title: "Code" },
];

export function getSourceSystemTabs(
  hasClonableSource: boolean,
): SourceSystemTab[] {
  return hasClonableSource ? [...SOURCE_SYSTEM_TABS] : [];
}
