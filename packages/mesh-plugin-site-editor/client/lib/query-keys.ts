export const QUERY_KEYS = {
  pages: (projectId: string) => ["site-editor", "pages", projectId] as const,
  page: (projectId: string, pageId: string) =>
    ["site-editor", "page", projectId, pageId] as const,
  blocks: (projectId: string) => ["site-editor", "blocks", projectId] as const,
  loaders: (projectId: string) =>
    ["site-editor", "loaders", projectId] as const,
  gitStatus: (projectId: string, pageId: string) =>
    ["site-editor", "git-status", projectId, pageId] as const,
  gitLog: (projectId: string, pageId: string) =>
    ["site-editor", "git-log", projectId, pageId] as const,
} as const;
