/**
 * Which report belongs to which project.
 *
 * The UI is written for N reports over N projects; the backend still keeps one
 * diagnostic per org (`WellKnownOrgMCPId.REPORTS`). This module is the only
 * place that knows the difference, so the server side can ship by writing the
 * per-project override and nothing here changes.
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

/** The per-project pointer, falling back to the org connection. Nothing writes
 *  it yet. */
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

/** Which project a diagnostic describes, by the host it ran against — never by
 *  sort order, which would put a stranger's numbers under a project's name. */
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
  /** Mapped rather than renamed at the banner, so its PostHog series keeps its
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
