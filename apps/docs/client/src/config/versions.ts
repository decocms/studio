export interface VersionConfig {
  id: string;
  label: string;
  shortLabel: string;
  description: string;
  isLatest: boolean;
  root: string;
}

export const versions: VersionConfig[] = [
  {
    id: "2026-03-10",
    label: "2026-03-10 (Current)",
    shortLabel: "2026-03-10",
    description: "Current production docs",
    isLatest: true,
    root: "mcp-mesh/quickstart",
  },
  {
    id: "2025-10-10",
    label: "2025-10-10",
    shortLabel: "2025-10-10",
    description: "Previous version docs",
    isLatest: false,
    root: "introduction",
  },
];

export const LATEST_VERSION = versions.find((v) => v.isLatest)!;
export const VERSION_IDS = versions.map((v) => v.id);
