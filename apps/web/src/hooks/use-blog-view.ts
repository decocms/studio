import { useOrgFlag, useOrgFlagState } from "@/hooks/use-organization-settings";
import { useProjectContextOptional } from "@/sdk/context/project-context";

/**
 * Whether the org turned on Blog as its own project view (`blog_view_enabled`).
 * Off, the blog stays in the Site Editor's Content tab and no view has a draft
 * kind, so a `blog-draft-` branch is a draft like any other.
 */
export function useBlogView(): boolean {
  return useOrgFlag("blog_view_enabled");
}

/**
 * {@link useBlogView}, `undefined` while the org settings load: for the gates
 * that route somewhere on it, which wait rather than send a Blog link to the
 * Content tab and then back. Off with no org (the account-less Site Editor),
 * whose settings never load.
 */
export function useBlogViewState(): boolean | undefined {
  const orgId = useProjectContextOptional()?.org.id;
  const flag = useOrgFlagState("blog_view_enabled");
  return orgId ? flag : false;
}
