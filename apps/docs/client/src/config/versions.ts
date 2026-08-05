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
    id: "deco-studio",
    label: "deco Studio - current",
    shortLabel: "deco Studio - current",
    description: "Current production docs",
    isLatest: true,
    root: "studio/quickstart",
  },
];

export const LATEST_VERSION = versions.find((v) => v.isLatest)!;
export const VERSION_IDS = versions.map((v) => v.id);
