import { createContext, useContext, type PropsWithChildren } from "react";

export interface BlogSandboxContextValue {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}

const BlogSandboxContext = createContext<BlogSandboxContextValue | null>(null);

export function BlogSandboxProvider({
  orgSlug,
  virtualMcpId,
  branch,
  children,
}: PropsWithChildren<BlogSandboxContextValue>) {
  return (
    <BlogSandboxContext.Provider value={{ orgSlug, virtualMcpId, branch }}>
      {children}
    </BlogSandboxContext.Provider>
  );
}

export function useBlogSandbox(): BlogSandboxContextValue | null {
  return useContext(BlogSandboxContext);
}
