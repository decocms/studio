import type {
  GaPropertyGroup,
  VerifiedSite,
} from "../companion-config-core.ts";

export interface CompanionConfigRendererProps {
  /** Current downstream configuration_state (already loaded). */
  currentValue: Record<string, unknown>;
  gaGroups: GaPropertyGroup[];
  gaError: boolean;
  verifiedSites: VerifiedSite[];
  saving: boolean;
  error: string | null;
  /** Persist a shallow patch onto the downstream configuration_state. */
  onSave: (patch: Record<string, unknown>) => void;
}
