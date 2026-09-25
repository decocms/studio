/**
 * Which report belongs to which project.
 *
 * The product is moving to N reports over N projects — an org like Hite runs a
 * Wake store and a Shopify store off different analytics accounts, and one
 * report per organization cannot describe both. The UI here is written for
 * that world. The BACKEND is not there yet: a diagnostic still lives on one
 * well-known per-org connection (`WellKnownOrgMCPId.REPORTS`), so exactly one
 * of an org's projects can have one at a time.
 *
 * This module is the seam between the two, and it is deliberately the ONLY
 * place that knows the difference:
 *
 *   - `projectReportConnectionId` answers "which connection holds this
 *     project's report". Today it reads a per-project override if one has been
 *     written and falls back to the org connection. The day reports become
 *     per-project, that override is the only thing that has to start being
 *     written — every screen that renders a report already asks this function.
 *   - `useProjectReports` attributes the ONE org diagnostic to the project it
 *     is actually about, by matching the claimed site against each project's
 *     store URL. Every other project reads "not run", which is true.
 *
 * Attribution by host rather than by "the first project" is the part worth
 * keeping: it is right under the current backend AND under the future one, so
 * the fallback can be deleted without rewriting the rule.
 */

import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { WellKnownOrgMCPId } from "@/sdk";
import { useReportsDiagnostic } from "@/hooks/use-reports-diagnostic";
import { deriveReportBannerStatus } from "@/hooks/reports-diagnostic-status";
import { readProjectProfile, storeHost } from "@/lib/project-profile.ts";

export type ProjectReportStatus = "ready" | "running" | "locked" | "none";

export interface ProjectReport {
  status: ProjectReportStatus;
  /** When the last completed run finished, ISO. */
  scannedAt: string | null;
  /** The connection the report is read from. */
  connectionId: string;
}

interface ProjectWithReportPointer {
  metadata?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The connection a project's report lives on.
 *
 * `metadata.project.reportConnectionId` is the per-project pointer. Nothing
 * writes it yet — it is read first on purpose, so the server side of this can
 * ship by writing it and nothing in the UI has to change.
 */
export function projectReportConnectionId(
  orgId: string,
  project: ProjectWithReportPointer,
): string {
  const metadata = isRecord(project.metadata) ? project.metadata : {};
  const profile = isRecord(metadata.project) ? metadata.project : {};
  const pinned = profile.reportConnectionId;
  return typeof pinned === "string" && pinned
    ? pinned
    : WellKnownOrgMCPId.REPORTS(orgId);
}

/**
 * Which project a diagnostic describes, by the host it was run against.
 *
 * Pure and exported for its test: the alternative — handing the org's one
 * report to whichever project sorts first — puts a stranger's numbers under a
 * project's name, which is worse than showing no report at all.
 */
export function projectForReportSite(
  projects: readonly VirtualMCPEntity[],
  siteUrl: string | null,
): VirtualMCPEntity | null {
  const target = storeHost(siteUrl);
  if (!target) return null;
  return (
    projects.find(
      (project) => storeHost(readProjectProfile(project).storeUrl) === target,
    ) ?? null
  );
}

export interface UseProjectReportsResult {
  byProject: Map<string, ProjectReport>;
  isLoading: boolean;
  /** The site the org's single diagnostic was run against, when there is one. */
  claimedSiteUrl: string | null;
  /**
   * True while a diagnostic exists that no project claims — the org ran a
   * report before projects had store URLs. The index offers to attach it.
   */
  unattributed: boolean;
}

export function useProjectReports(
  projects: readonly VirtualMCPEntity[],
): UseProjectReportsResult {
  const { diagnostic, isLoading, siteUrl, connectionId } =
    useReportsDiagnostic();

  const byProject = new Map<string, ProjectReport>();
  const owner = projectForReportSite(projects, siteUrl);
  /** The banner's vocabulary says "generating"; a row says "running". Mapped
   *  here rather than renamed there, so the banner's PostHog series keeps its
   *  values. */
  const derived = deriveReportBannerStatus(diagnostic);
  const status: ProjectReportStatus =
    derived === "generating" ? "running" : derived;

  for (const project of projects) {
    const isOwner = owner?.id === project.id;
    byProject.set(project.id, {
      status: isOwner ? (diagnostic?.locked ? "locked" : status) : "none",
      scannedAt: isOwner ? (diagnostic?.scanned_at ?? null) : null,
      connectionId,
    });
  }

  return {
    byProject,
    isLoading,
    claimedSiteUrl: siteUrl,
    unattributed: !!diagnostic && !owner,
  };
}
