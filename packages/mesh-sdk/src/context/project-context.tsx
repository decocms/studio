import { createContext, useContext, type PropsWithChildren } from "react";

/**
 * A ProjectLocator is an ID-based string that identifies a project in an organization.
 *
 * format: <orgId>/<projectId>
 */
export type ProjectLocator = `${string}/${string}`;

export type LocatorStructured = {
  org: string;
  project: string;
};

export const Locator = {
  from({ org, project }: LocatorStructured): ProjectLocator {
    return `${org}/${project}` as ProjectLocator;
  },
  parse(locator: ProjectLocator): LocatorStructured {
    if (locator.startsWith("/")) {
      locator = locator.slice(1) as ProjectLocator;
    }
    const [org, project] = locator.split("/");
    if (!org || !project) {
      throw new Error("Invalid locator");
    }
    return { org, project };
  },
} as const;

/**
 * Project UI customization
 */
export interface ProjectUI {
  banner: string | null;
  bannerColor: string | null;
  icon: string | null;
  themeColor: string | null;
}

/**
 * Organization data in context
 */
export interface OrganizationData {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
}

/**
 * Project data in context
 * Includes full project info when loaded from storage
 */
export interface ProjectData {
  /** Project ID */
  id: string;
  /** Organization ID (only available when loaded from storage) */
  organizationId?: string;
  /** Project slug */
  slug: string;
  /** Project display name */
  name?: string;
  /** Project description */
  description?: string | null;
  /** Enabled plugins */
  enabledPlugins?: string[] | null;
  /** UI customization */
  ui?: ProjectUI | null;
  /** Whether this is the org-admin project */
  isOrgAdmin?: boolean;
}

interface ProjectContextType {
  org: OrganizationData;
  project: ProjectData;
  locator: ProjectLocator;
}

const ProjectContext = createContext<ProjectContextType | undefined>(undefined);

export const useProjectContext = () => {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error(
      "useProjectContext must be used within a ProjectContextProvider",
    );
  }

  return context;
};

/**
 * Convenience hook to get organization data
 */
export const useOrg = () => {
  return useProjectContext().org;
};

/**
 * Convenience hook to get current project data
 */
export const useCurrentProject = () => {
  return useProjectContext().project;
};

/**
 * Convenience hook to check if current project is org-admin
 */
export const useIsOrgAdmin = () => {
  const project = useProjectContext().project;
  return project.isOrgAdmin === true;
};

export type ProjectContextProviderProps = {
  org: OrganizationData;
  project: ProjectData;
};

export const ProjectContextProvider = ({
  children,
  org,
  project,
}: PropsWithChildren<ProjectContextProviderProps>) => {
  const locator = Locator.from({ org: org.id, project: project.id });

  const value = { org, project, locator };

  return (
    <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
  );
};
