import type { RepositoryBinding } from "@decocms/shared/sdk/types";

/** A project with a site, as the org views read it. */
export interface SiteProject {
  id: string;
  title: string;
  icon: string | null | undefined;
  /** The site its experiments live under. */
  site: string;
  /** The site its traffic is reported under, which a migration may override. */
  analyticsSite: string;
  /** Where its code lives, when the project has a repository linked. */
  repository: RepositoryBinding | null;
}
